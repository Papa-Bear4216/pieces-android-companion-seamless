package com.pieces.android.companion;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionHandler;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Native Durable Outbox and Background HTTP Sync.
 *
 * Decouples telemetry ingestion and syncing from the Capacitor React/WebView lifecycle.
 * Runs independently within native background services (PiecesAccessibilityService &
 * NotificationCaptureService) even while the device is locked or the companion app is
 * swiped away from Recents.
 *
 * Architecture & Privacy Model:
 * 1. Native Opt-in & Denylist Enforced at Capture:
 *    - Captures occur ONLY if the user explicitly enabled screenContextEnabled or notificationCaptureEnabled.
 *    - Strict package denylists (banking, password managers, auth, medical apps) are checked natively
 *      before text is ever extracted or queued.
 *    - Keyguard is checked: no screen text is extracted while the device is locked.
 * 2. Background Direct Ingestion (triaged: false):
 *    - On Android, Gemini Nano / AICore requires the hosting app to be in the foreground; background
 *      services cannot execute on-device LLM inference while another app is active.
 *    - To fulfill the user's requirement for 24/7 background syncing without keeping the app open,
 *      native background events are queued with triaged=false and delivered directly to the user's
 *      local proxy (Plan A) or private remote gateway (Plan B).
 *    - The user's personal proxy (seeder.ts) performs summarization, entity extraction, and surprisal
 *      filtering before seeding into PiecesOS and Mem0.
 * 3. ACID Durability & Monotonic FIFO:
 *    - Backed by Android's native SQLite (telemetry_outbox.db) with autoincrement sequence keys.
 *    - Durability begins upon successful SQLite transaction commit.
 *    - FIFO retention capped at 500 records; pruned/overload drops tracked via getDroppedCount().
 *    - Atomic quarantine and outbox removal executed in a single transaction after cursor closure.
 *    - Per-run execution contexts (FlushRun) with drain-request tracking prevent lost flushes during worker shutdown.
 *    - Epoch-tracked retry scheduling prevents stale retries from restarting work after cancellation.
 *    - Dedicated status query executor ensures UI plugin promises never hang under capture overload.
 *    - Network-constrained persistent JobScheduler (TelemetrySyncJobService) drains outbox across process restarts.
 */
public class NativeTelemetrySync {

    private static final String TAG = "NativeTelemetrySync";
    private static final String DB_NAME = "telemetry_outbox.db";
    private static final int DB_VERSION = 2; // Incremented for seq autoincrement schema
    private static final String TABLE_OUTBOX = "outbox";
    private static final String TABLE_QUARANTINE = "quarantine";
    private static final String TABLE_META = "migration_meta";

    public static final int JOB_ID = 878701;
    private static final int MAX_OUTBOX_EVENTS = 500;
    private static final int MAX_QUARANTINE_EVENTS = 100;
    private static final int BATCH_SIZE = 50;
    private static final int MAX_BATCH_BYTES = 256 * 1024; // 256 KB max payload per HTTP request

    // Bounds on incoming event fields
    private static final int MAX_PKG_CHARS = 150;
    private static final int MAX_LABEL_CHARS = 150;
    private static final int MAX_TITLE_CHARS = 500;
    private static final int MAX_SINGLE_TEXT_CHARS = 16_000;

    private static final AtomicLong droppedEventsCount = new AtomicLong(0);

    // Marker interface to distinguish capture tasks from internal control tasks
    private interface CaptureTask extends Runnable {}

    private static final RejectedExecutionHandler DISK_REJECTED_HANDLER = (r, executor) -> {
        if (r instanceof CaptureTask) {
            droppedEventsCount.incrementAndGet();
            Log.w(TAG, "DISK_EXECUTOR saturated; capture task dropped under overload.");
        }
    };

    // Bounded disk executor keeps database operations off callback threads
    private static final ExecutorService DISK_EXECUTOR = new ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(1000),
        DISK_REJECTED_HANDLER
    );

    private static final RejectedExecutionHandler STATUS_REJECTED_HANDLER = (r, executor) -> {
        Log.w(TAG, "STATUS_EXECUTOR saturated; status query dropped under overload.");
    };

    // Bounded executor for status queries so UI promises NEVER hang on disk saturation or leak threads
    private static final ExecutorService STATUS_EXECUTOR = new ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(50),
        STATUS_REJECTED_HANDLER
    );

    private static final ExecutorService NETWORK_EXECUTOR = Executors.newSingleThreadExecutor();
    private static final ScheduledExecutorService RETRY_SCHEDULER = Executors.newSingleThreadScheduledExecutor();
    private static ScheduledFuture<?> scheduledRetry = null;

    public interface FlushListener {
        void onComplete(boolean success);
    }

    public enum FlushOutcome {
        DRAINED,
        FAILED,
        CANCELLED,
        UNCONFIGURED
    }

    // Per-run execution context isolating lifecycle, cancellation, listeners, and pending drain requests
    private static class FlushRun {
        final long runId;
        final long epoch;
        boolean force;
        volatile boolean cancelled = false;
        boolean drainRequested = false;
        volatile HttpURLConnection activeConnection = null;
        final List<FlushListener> listeners = new ArrayList<>();
        FlushOutcome outcome = FlushOutcome.FAILED;

        FlushRun(long runId, long epoch, boolean force) {
            this.runId = runId;
            this.epoch = epoch;
            this.force = force;
        }

        void disconnectActive() {
            HttpURLConnection conn = activeConnection;
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {}
            }
        }
    }

    private static final Object FLUSH_LOCK = new Object();
    private static FlushRun activeRun = null;
    private static FlushRun pendingRun = null;
    private static long nextRunId = 1;
    private static volatile long currentEpoch = 1; // Cancellation epoch tracking

    private static volatile long lastFailureElapsed = 0;
    private static final long MIN_RETRY_INTERVAL_MS = 30_000; // 30s monotonic backoff after failure

    // SQLite Database Helper
    private static class DatabaseHelper extends SQLiteOpenHelper {
        DatabaseHelper(Context context) {
            super(context, DB_NAME, null, DB_VERSION);
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_OUTBOX + " ("
                    + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                    + "id TEXT UNIQUE NOT NULL, "
                    + "payload TEXT NOT NULL, "
                    + "created_at INTEGER NOT NULL"
                    + ")");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_seq ON " + TABLE_OUTBOX + "(seq)");

            db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_QUARANTINE + " ("
                    + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                    + "id TEXT UNIQUE NOT NULL, "
                    + "payload TEXT NOT NULL, "
                    + "reason TEXT NOT NULL, "
                    + "created_at INTEGER NOT NULL"
                    + ")");

            db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_META + " ("
                    + "key TEXT PRIMARY KEY, "
                    + "val TEXT NOT NULL"
                    + ")");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
            if (oldVersion < 2) {
                // Check which legacy tables exist before attempting migration
                boolean hasOutbox = false;
                boolean hasQuarantine = false;
                Cursor c = null;
                try {
                    c = db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)",
                            new String[]{TABLE_OUTBOX, TABLE_QUARANTINE});
                    while (c != null && c.moveToNext()) {
                        String name = c.getString(0);
                        if (TABLE_OUTBOX.equals(name)) hasOutbox = true;
                        if (TABLE_QUARANTINE.equals(name)) hasQuarantine = true;
                    }
                } finally {
                    if (c != null) c.close();
                }

                // Migrate outbox table to autoincrement sequence schema, preserving FIFO via created_at
                db.execSQL("CREATE TABLE IF NOT EXISTS outbox_new ("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "id TEXT UNIQUE NOT NULL, "
                        + "payload TEXT NOT NULL, "
                        + "created_at INTEGER NOT NULL)");
                if (hasOutbox) {
                    db.execSQL("INSERT OR IGNORE INTO outbox_new (id, payload, created_at) "
                            + "SELECT id, payload, created_at FROM " + TABLE_OUTBOX + " ORDER BY created_at ASC");
                    db.execSQL("DROP TABLE IF EXISTS " + TABLE_OUTBOX);
                }
                db.execSQL("ALTER TABLE outbox_new RENAME TO " + TABLE_OUTBOX);
                db.execSQL("CREATE INDEX IF NOT EXISTS idx_outbox_seq ON " + TABLE_OUTBOX + "(seq)");

                // Migrate quarantine table to autoincrement sequence schema
                db.execSQL("CREATE TABLE IF NOT EXISTS quarantine_new ("
                        + "seq INTEGER PRIMARY KEY AUTOINCREMENT, "
                        + "id TEXT UNIQUE NOT NULL, "
                        + "payload TEXT NOT NULL, "
                        + "reason TEXT NOT NULL, "
                        + "created_at INTEGER NOT NULL)");
                if (hasQuarantine) {
                    db.execSQL("INSERT OR IGNORE INTO quarantine_new (id, payload, reason, created_at) "
                            + "SELECT id, payload, reason, created_at FROM " + TABLE_QUARANTINE + " ORDER BY created_at ASC");
                    db.execSQL("DROP TABLE IF EXISTS " + TABLE_QUARANTINE);
                }
                db.execSQL("ALTER TABLE quarantine_new RENAME TO " + TABLE_QUARANTINE);

                db.execSQL("CREATE TABLE IF NOT EXISTS " + TABLE_META + " (key TEXT PRIMARY KEY, val TEXT NOT NULL)");
            }
        }
    }

    private static volatile DatabaseHelper dbHelper = null;
    private static volatile SQLiteDatabase readyDb = null;
    private static volatile boolean isDbReady = false;
    private static final Object INIT_LOCK = new Object();

    private static boolean ensureInitialized(Context context) {
        if (isDbReady && readyDb != null) return true;
        synchronized (INIT_LOCK) {
            if (isDbReady && readyDb != null) return true;
            Context appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
            if (dbHelper == null) {
                dbHelper = new DatabaseHelper(appContext);
            }
            try {
                SQLiteDatabase db = dbHelper.getWritableDatabase();
                if (migrateLegacyJsonl(appContext, db)) {
                    readyDb = db;
                    isDbReady = true;
                    return true;
                } else {
                    Log.w(TAG, "Legacy JSONL migration did not complete successfully; DB not marked ready yet");
                    return false;
                }
            } catch (Exception e) {
                Log.e(TAG, "Database initialization failed", e);
                return false;
            }
        }
    }

    public static void warmUpDatabaseAsync(Context context) {
        DISK_EXECUTOR.execute(() -> {
            try {
                ensureInitialized(context);
                Log.d(TAG, "Database warm-up completed; ready=" + isDbReady);
            } catch (Exception e) {
                Log.w(TAG, "Database warm-up failed", e);
            }
        });
    }

    private static boolean isLegacyMigrated(SQLiteDatabase db) {
        Cursor cursor = null;
        try {
            cursor = db.query(TABLE_META, new String[]{"val"}, "key = ?", new String[]{"legacy_migrated"}, null, null, null);
            return cursor != null && cursor.moveToFirst() && "1".equals(cursor.getString(0));
        } catch (Exception e) {
            return false;
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private static boolean migrateLegacyJsonl(Context context, SQLiteDatabase db) {
        if (isLegacyMigrated(db)) return true;

        File legacyFile = new File(context.getFilesDir(), "telemetry_outbox.jsonl");
        if (!legacyFile.exists()) {
            return markLegacyMigrated(db);
        }

        List<String> validPayloads = new ArrayList<>();
        List<String> validIds = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(legacyFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String trimmed = line.trim();
                if (!trimmed.isEmpty()) {
                    try {
                        JSONObject obj = new JSONObject(trimmed);
                        String id = obj.optString("id", "").trim();
                        if (id.isEmpty()) {
                            id = UUID.randomUUID().toString();
                            obj.put("id", id);
                        }
                        if (!obj.has("telemetry") || !obj.has("package") || !obj.has("timestamp")) {
                            Log.w(TAG, "Legacy record missing required fields; skipping: " + id);
                            continue;
                        }
                        validIds.add(id);
                        validPayloads.add(obj.toString());
                    } catch (Exception ignored) {
                        // Isolate malformed JSON records
                    }
                }
            }
        } catch (IOException e) {
            Log.w(TAG, "Failed reading legacy jsonl file", e);
            return false;
        }

        if (validPayloads.isEmpty()) {
            legacyFile.delete();
            File bak = new File(context.getFilesDir(), "telemetry_outbox.jsonl.bak");
            if (bak.exists()) bak.delete();
            return markLegacyMigrated(db);
        }

        int start = Math.max(0, validPayloads.size() - MAX_OUTBOX_EVENTS);
        if (start > 0) {
            droppedEventsCount.addAndGet(start);
        }
        db.beginTransaction();
        try {
            for (int i = start; i < validPayloads.size(); i++) {
                ContentValues cv = new ContentValues();
                cv.put("id", validIds.get(i));
                cv.put("payload", validPayloads.get(i));
                cv.put("created_at", System.currentTimeMillis());
                long inserted = db.insertWithOnConflict(TABLE_OUTBOX, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                if (inserted == -1) {
                    throw new SQLiteException("Failed inserting legacy record: " + validIds.get(i));
                }
            }
            // Enforce combined retention cap
            db.execSQL("DELETE FROM " + TABLE_OUTBOX + " WHERE seq NOT IN ("
                    + "SELECT seq FROM " + TABLE_OUTBOX + " ORDER BY seq DESC LIMIT " + MAX_OUTBOX_EVENTS + ")");

            ContentValues metaCv = new ContentValues();
            metaCv.put("key", "legacy_migrated");
            metaCv.put("val", "1");
            long markerInserted = db.insertWithOnConflict(TABLE_META, null, metaCv, SQLiteDatabase.CONFLICT_REPLACE);
            if (markerInserted == -1) {
                throw new SQLiteException("Failed inserting legacy migration marker");
            }

            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.e(TAG, "Transaction failed during legacy migration; preserving source file", e);
            return false;
        } finally {
            db.endTransaction();
        }

        legacyFile.delete();
        File bak = new File(context.getFilesDir(), "telemetry_outbox.jsonl.bak");
        if (bak.exists()) bak.delete();
        Log.i(TAG, "Legacy jsonl migrated to SQLite successfully with transactional commit");
        return true;
    }

    private static boolean markLegacyMigrated(SQLiteDatabase db) {
        try {
            ContentValues metaCv = new ContentValues();
            metaCv.put("key", "legacy_migrated");
            metaCv.put("val", "1");
            long inserted = db.insertWithOnConflict(TABLE_META, null, metaCv, SQLiteDatabase.CONFLICT_REPLACE);
            return inserted != -1;
        } catch (Exception e) {
            Log.w(TAG, "Failed marking legacy as migrated", e);
            return false;
        }
    }

    public static class Target {
        public final String baseUrl;
        public final String token;
        public final String mode;

        public Target(String baseUrl, String token, String mode) {
            this.baseUrl = baseUrl.replaceAll("/+$", "");
            this.token = token;
            this.mode = mode;
        }
    }

    /**
     * Schedules a persistent, network-constrained periodic JobService to drain SQLite outbox
     * across application process termination and reboots.
     */
    public static void schedulePeriodicJob(Context context) {
        try {
            JobScheduler js = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo pending = js.getPendingJob(JOB_ID);
            if (pending != null) return;

            ComponentName service = new ComponentName(context, TelemetrySyncJobService.class);
            JobInfo.Builder builder = new JobInfo.Builder(JOB_ID, service)
                    .setPeriodic(15 * 60 * 1000) // 15-minute periodic backstop
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true);
            js.schedule(builder.build());
        } catch (Exception e) {
            Log.w(TAG, "Failed to schedule persistent background job", e);
        }
    }

    public static void requestCancelFlush() {
        requestCancelFlush(-1);
    }

    public static void requestCancelFlush(long targetRunId) {
        List<FlushListener> listenersToNotify = new ArrayList<>();
        synchronized (FLUSH_LOCK) {
            if (targetRunId != -1) {
                // Scope cancellation strictly to the specified run ID
                if (activeRun != null && activeRun.runId == targetRunId) {
                    currentEpoch++;
                    activeRun.cancelled = true;
                    activeRun.disconnectActive();
                }
                if (pendingRun != null && pendingRun.runId == targetRunId) {
                    pendingRun.cancelled = true;
                    pendingRun.disconnectActive();
                    listenersToNotify.addAll(pendingRun.listeners);
                    pendingRun = null;
                }
            } else {
                // Global cancellation
                currentEpoch++;
                if (activeRun != null) {
                    activeRun.cancelled = true;
                    activeRun.disconnectActive();
                }
                if (pendingRun != null) {
                    pendingRun.cancelled = true;
                    pendingRun.disconnectActive();
                    listenersToNotify.addAll(pendingRun.listeners);
                    pendingRun = null;
                }
                if (scheduledRetry != null) {
                    scheduledRetry.cancel(false);
                    scheduledRetry = null;
                }
            }
        }
        for (FlushListener l : listenersToNotify) {
            try {
                l.onComplete(false);
            } catch (Exception ignored) {}
        }
    }

    /**
     * Queues a screen-context event to the native durable outbox.
     */
    public static void queueScreenCapture(Context context, String packageName, String appLabel, String textNodes) {
        final Context appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        final long captureTime = System.currentTimeMillis();
        final String safePkg = truncate(packageName, MAX_PKG_CHARS);
        final String safeLabel = truncate(appLabel, MAX_LABEL_CHARS);
        final String safeText = truncate(textNodes, MAX_SINGLE_TEXT_CHARS);

        DISK_EXECUTOR.execute((CaptureTask) () -> {
            try {
                JSONObject event = new JSONObject();
                event.put("id", "native-screen-" + captureTime + "-" + UUID.randomUUID().toString().substring(0, 8));
                event.put("type", "system_telemetry");
                event.put("screen", "background");
                event.put("telemetry", "Package: " + safePkg + "\n\n" + safeText);
                event.put("package", safePkg);
                event.put("app_label", safeLabel);
                event.put("timestamp", formatIsoUtc(captureTime));
                event.put("triaged", false);

                appendEvent(appContext, event);
                flushAsync(appContext);
            } catch (Exception e) {
                droppedEventsCount.incrementAndGet();
                Log.e(TAG, "Failed to queue screen capture", e);
            }
        });
    }

    /**
     * Queues a notification event to the native durable outbox.
     */
    public static void queueNotification(Context context, String packageName, String appLabel, String title, String text, long postedAt) {
        final Context appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        final long captureTime = postedAt > 0 ? postedAt : System.currentTimeMillis();
        final String safePkg = truncate(packageName, MAX_PKG_CHARS);
        final String safeLabel = truncate(appLabel, MAX_LABEL_CHARS);
        final String safeTitle = truncate(title, MAX_TITLE_CHARS);
        final String safeText = truncate(text, MAX_SINGLE_TEXT_CHARS);

        DISK_EXECUTOR.execute((CaptureTask) () -> {
            try {
                JSONObject event = new JSONObject();
                event.put("id", "native-notif-" + captureTime + "-" + UUID.randomUUID().toString().substring(0, 8));
                event.put("type", "system_telemetry");
                event.put("screen", "background");
                String titleLine = !safeTitle.isEmpty() ? "TITLE: " + safeTitle + "\n" : "";
                event.put("telemetry", "Notification from " + safeLabel + " (" + safePkg + ")\n" + titleLine + safeText);
                event.put("package", safePkg);
                event.put("app_label", safeLabel);
                event.put("timestamp", formatIsoUtc(captureTime));
                event.put("triaged", false);

                appendEvent(appContext, event);
                flushAsync(appContext);
            } catch (Exception e) {
                droppedEventsCount.incrementAndGet();
                Log.e(TAG, "Failed to queue notification", e);
            }
        });
    }

    private static String truncate(String val, int max) {
        if (val == null) return "";
        val = val.trim();
        return val.length() > max ? val.substring(0, max) : val;
    }

    private static String formatIsoUtc(long millis) {
        SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
        return sdf.format(new Date(millis));
    }

    private static void appendEvent(Context context, JSONObject event) {
        String id = event.optString("id", "").trim();
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString();
            try {
                event.put("id", id);
            } catch (Exception ignored) {}
        }
        String payload = event.toString();
        long now = System.currentTimeMillis();

        if (!ensureInitialized(context) || readyDb == null) {
            droppedEventsCount.incrementAndGet();
            Log.w(TAG, "Cannot append event; database not ready: " + id);
            return;
        }

        try {
            SQLiteDatabase db = readyDb;
            db.beginTransaction();
            try {
                ContentValues cv = new ContentValues();
                cv.put("id", id);
                cv.put("payload", payload);
                cv.put("created_at", now);
                long inserted = db.insertWithOnConflict(TABLE_OUTBOX, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                if (inserted == -1) {
                    throw new SQLiteException("Insert returned -1");
                }

                long count = DatabaseUtils.queryNumEntries(db, TABLE_OUTBOX);
                if (count > MAX_OUTBOX_EVENTS) {
                    int pruned = db.delete(TABLE_OUTBOX, "seq NOT IN ("
                            + "SELECT seq FROM " + TABLE_OUTBOX + " ORDER BY seq DESC LIMIT " + MAX_OUTBOX_EVENTS + ")", null);
                    if (pruned > 0) {
                        droppedEventsCount.addAndGet(pruned);
                    }
                }
                db.setTransactionSuccessful();
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            droppedEventsCount.incrementAndGet();
            Log.e(TAG, "Failed to persist event to SQLite outbox", e);
        }
    }

    public interface OutboxStatusCallback {
        void onStatus(int pending, boolean isFlushing, long dropped, boolean isReady);
    }

    public static void getOutboxStatusAsync(Context context, OutboxStatusCallback callback) {
        STATUS_EXECUTOR.execute(() -> {
            boolean ready = ensureInitialized(context);
            int pending = 0;
            if (ready && readyDb != null) {
                try {
                    pending = (int) DatabaseUtils.queryNumEntries(readyDb, TABLE_OUTBOX);
                } catch (Exception ignored) {}
            }
            boolean flushing = isFlushing();
            long dropped = getDroppedCount();
            callback.onStatus(pending, flushing, dropped, ready);
        });
    }

    public static int getPendingCount(Context context) {
        if (!ensureInitialized(context) || readyDb == null) {
            return 0;
        }
        try {
            return (int) DatabaseUtils.queryNumEntries(readyDb, TABLE_OUTBOX);
        } catch (Exception e) {
            Log.w(TAG, "Failed to query pending count", e);
            return 0;
        }
    }

    public static long getDroppedCount() {
        return droppedEventsCount.get();
    }

    public static boolean isFlushing() {
        synchronized (FLUSH_LOCK) {
            return activeRun != null && !activeRun.cancelled;
        }
    }

    /**
     * Reads configured connection targets from CapacitorStorage SharedPreferences.
     */
    public static List<Target> getConnectionTargets(Context context) {
        List<Target> targets = new ArrayList<>();
        try {
            SharedPreferences prefs = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
            String lanUrl = prefs.getString("pieces-android:proxyBaseUrl", null);
            String lanToken = prefs.getString("pieces-android:proxyToken", null);
            String remoteUrl = prefs.getString("pieces-android:remoteGatewayUrl", null);
            String remoteToken = prefs.getString("pieces-android:remoteGatewayToken", null);

            if (lanUrl != null && !lanUrl.trim().isEmpty() && lanToken != null && !lanToken.trim().isEmpty()) {
                targets.add(new Target(lanUrl.trim(), lanToken.trim(), "lan"));
            }
            if (remoteUrl != null && !remoteUrl.trim().isEmpty() && remoteToken != null && !remoteToken.trim().isEmpty()) {
                targets.add(new Target(remoteUrl.trim(), remoteToken.trim(), "remote"));
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to read connection targets", e);
        }
        return targets;
    }

    public static long flushJobAsync(Context context, FlushListener listener) {
        long[] assignedRunId = new long[]{-1};
        flushInternalStart(context, true, listener, -1, assignedRunId);
        return assignedRunId[0];
    }

    public static String flushAsync(Context context) {
        return flushAsync(context, false, null);
    }

    public static String flushAsync(Context context, boolean force) {
        return flushAsync(context, force, null);
    }

    public static String flushAsync(Context context, boolean force, FlushListener listener) {
        return flushInternalStart(context, force, listener, -1, null);
    }

    private static String flushInternalStart(Context context, boolean force, FlushListener listener, long expectedEpoch, long[] outRunId) {
        schedulePeriodicJob(context);

        long elapsed = SystemClock.elapsedRealtime();
        long failure = lastFailureElapsed;
        if (!force && failure != 0 && (elapsed - failure < MIN_RETRY_INTERVAL_MS)) {
            if (listener != null) {
                listener.onComplete(false);
            }
            return "skipped_backoff";
        }

        FlushRun runToLaunch = null;

        synchronized (FLUSH_LOCK) {
            if (expectedEpoch != -1 && expectedEpoch != currentEpoch) {
                Log.d(TAG, "flushInternalStart: expectedEpoch " + expectedEpoch + " != currentEpoch " + currentEpoch + "; aborting stale retry");
                if (listener != null) {
                    listener.onComplete(false);
                }
                return "stale_epoch";
            }
            if (expectedEpoch != -1) {
                scheduledRetry = null;
            }

            if (activeRun != null) {
                if (activeRun.cancelled) {
                    // Active run is cancelled and terminating; queue a successor run
                    if (pendingRun == null) {
                        pendingRun = new FlushRun(nextRunId++, currentEpoch, force);
                    }
                    if (listener != null) {
                        pendingRun.listeners.add(listener);
                    }
                    pendingRun.force = pendingRun.force || force;
                    if (outRunId != null) {
                        outRunId[0] = pendingRun.runId;
                    }
                    return "queued_behind_cancelled";
                } else {
                    // Join active running flush and mark drainRequested so worker does not exit prematurely
                    activeRun.drainRequested = true;
                    if (listener != null) {
                        activeRun.listeners.add(listener);
                    }
                    activeRun.force = activeRun.force || force;
                    if (outRunId != null) {
                        outRunId[0] = activeRun.runId;
                    }
                    return "already_running";
                }
            }

            // Start a new active run
            if (expectedEpoch == -1) {
                currentEpoch++; // Start fresh epoch for explicit flush
            }
            if (scheduledRetry != null) {
                scheduledRetry.cancel(false);
                scheduledRetry = null;
            }
            activeRun = new FlushRun(nextRunId++, currentEpoch, force);
            if (listener != null) {
                activeRun.listeners.add(listener);
            }
            if (outRunId != null) {
                outRunId[0] = activeRun.runId;
            }
            runToLaunch = activeRun;
        }

        final Context appContext = context.getApplicationContext() != null ? context.getApplicationContext() : context;
        final FlushRun run = runToLaunch;

        NETWORK_EXECUTOR.execute(() -> executeRun(appContext, run));
        return "flush_started";
    }

    private static void executeRun(Context appContext, FlushRun currentRun) {
        FlushRun nextRun = null;
        try {
            while (!currentRun.cancelled) {
                FlushOutcome outcome = flushInternal(appContext, currentRun);
                currentRun.outcome = outcome;

                if (outcome == FlushOutcome.CANCELLED || outcome == FlushOutcome.UNCONFIGURED) {
                    break;
                }

                if (outcome == FlushOutcome.DRAINED) {
                    boolean shouldContinue = false;
                    synchronized (FLUSH_LOCK) {
                        if (currentRun.drainRequested && !currentRun.cancelled) {
                            currentRun.drainRequested = false;
                            shouldContinue = true;
                        } else {
                            if (activeRun == currentRun) {
                                activeRun = pendingRun;
                                nextRun = activeRun;
                                pendingRun = null;
                            }
                        }
                    }
                    if (shouldContinue) {
                        continue; // Continue draining newly enqueued events before exiting
                    }
                    break;
                }

                if (outcome == FlushOutcome.FAILED) {
                    long now = SystemClock.elapsedRealtime();
                    if (lastFailureElapsed != 0 && (now - lastFailureElapsed < MIN_RETRY_INTERVAL_MS)) {
                        long remaining = MIN_RETRY_INTERVAL_MS - (now - lastFailureElapsed);
                        scheduleRetry(appContext, remaining, currentRun);
                        break;
                    }
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "Fatal error in flush worker", t);
            currentRun.outcome = FlushOutcome.FAILED;
            lastFailureElapsed = SystemClock.elapsedRealtime();
            scheduleRetry(appContext, MIN_RETRY_INTERVAL_MS, currentRun);
        } finally {
            List<FlushListener> listenersToNotify;
            boolean success = (currentRun.outcome == FlushOutcome.DRAINED);

            synchronized (FLUSH_LOCK) {
                listenersToNotify = new ArrayList<>(currentRun.listeners);
                if (activeRun == currentRun) {
                    activeRun = pendingRun;
                    nextRun = activeRun;
                    pendingRun = null;
                }
            }

            for (FlushListener l : listenersToNotify) {
                try {
                    l.onComplete(success);
                } catch (Exception ignored) {}
            }

            if (nextRun != null) {
                final FlushRun r = nextRun;
                NETWORK_EXECUTOR.execute(() -> executeRun(appContext, r));
            }
        }
    }

    public enum BatchStatus {
        SUCCESS,
        EMPTY,
        READ_ERROR
    }

    private static class CorruptRecord {
        final String id;
        final String payload;
        final String reason;
        CorruptRecord(String id, String payload, String reason) {
            this.id = id;
            this.payload = payload;
            this.reason = reason;
        }
    }

    private static class OutboxBatch {
        BatchStatus status = BatchStatus.EMPTY;
        final List<String> ids = new ArrayList<>();
        final List<String> serializedEntries = new ArrayList<>();
        int corruptPrunedCount = 0;
    }

    private static OutboxBatch readBatch(Context context, int maxCount, FlushRun run) {
        OutboxBatch batch = new OutboxBatch();
        Cursor cursor = null;
        List<CorruptRecord> toQuarantine = new ArrayList<>();
        if (!ensureInitialized(context) || readyDb == null) {
            batch.status = BatchStatus.READ_ERROR;
            return batch;
        }
        try {
            SQLiteDatabase db = readyDb;
            // Strictly deterministic FIFO ordering via autoincrement sequence
            cursor = db.query(TABLE_OUTBOX, new String[]{"id", "payload"},
                    null, null, null, null, "seq ASC", String.valueOf(maxCount));
            int totalPayloadBytes = 0;
            while (cursor.moveToNext() && !run.cancelled) {
                String id = cursor.getString(0);
                String rawPayload = cursor.getString(1);

                String serialized;
                byte[] objBytes;
                try {
                    JSONObject obj = new JSONObject(rawPayload);
                    if (!obj.has("telemetry") || !obj.has("package") || !obj.has("timestamp")) {
                        Log.w(TAG, "Record missing required fields; queueing for quarantine: " + id);
                        toQuarantine.add(new CorruptRecord(id, rawPayload, "Record missing required fields"));
                        continue;
                    }
                    serialized = obj.toString();
                    objBytes = serialized.getBytes(StandardCharsets.UTF_8);
                } catch (Exception e) {
                    Log.w(TAG, "Corrupt payload found in outbox; queueing for quarantine: " + id);
                    toQuarantine.add(new CorruptRecord(id, rawPayload, "Corrupt JSON record"));
                    continue;
                }

                // Envelope {"events":[]} is 13 UTF-8 bytes + 1 comma per additional entry
                int envelopeOverhead = 13 + batch.serializedEntries.size();
                int projectedTotal = totalPayloadBytes + objBytes.length + envelopeOverhead;

                // Handle oversized singleton before transmission
                if (objBytes.length + 13 > MAX_BATCH_BYTES) {
                    Log.w(TAG, "Singleton event exceeds MAX_BATCH_BYTES (" + objBytes.length + " bytes); queueing for quarantine: " + id);
                    toQuarantine.add(new CorruptRecord(id, serialized, "Event exceeds MAX_BATCH_BYTES"));
                    continue;
                }

                if (!batch.serializedEntries.isEmpty() && projectedTotal > MAX_BATCH_BYTES) {
                    break; // Batch capacity reached
                }

                batch.ids.add(id);
                batch.serializedEntries.add(serialized);
                totalPayloadBytes += objBytes.length;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error querying outbox batch", e);
            batch.status = BatchStatus.READ_ERROR;
            return batch;
        } finally {
            if (cursor != null) cursor.close();
        }

        // Quarantine corrupt or oversized items AFTER cursor is safely closed
        for (CorruptRecord cr : toQuarantine) {
            if (!quarantineAndRemoveEvent(context, cr.id, cr.payload, cr.reason)) {
                batch.status = BatchStatus.READ_ERROR;
                return batch;
            }
            batch.corruptPrunedCount++;
        }

        if (!batch.ids.isEmpty()) {
            batch.status = BatchStatus.SUCCESS;
        } else {
            batch.status = BatchStatus.EMPTY;
        }

        return batch;
    }

    private static FlushOutcome flushInternal(Context context, FlushRun run) {
        List<Target> targets = getConnectionTargets(context);
        if (targets.isEmpty()) {
            return FlushOutcome.UNCONFIGURED;
        }

        int maxBatchCount = BATCH_SIZE;

        while (!run.cancelled) {
            OutboxBatch batch = readBatch(context, maxBatchCount, run);

            if (run.cancelled) {
                return FlushOutcome.CANCELLED;
            }

            if (batch.status == BatchStatus.READ_ERROR) {
                lastFailureElapsed = SystemClock.elapsedRealtime();
                scheduleRetry(context, MIN_RETRY_INTERVAL_MS, run);
                return FlushOutcome.FAILED;
            }

            if (batch.status == BatchStatus.EMPTY) {
                if (batch.corruptPrunedCount > 0) {
                    continue; // Scanned corrupt entries; check next window
                }
                return FlushOutcome.DRAINED; // Outbox empty
            }

            StringBuilder sb = new StringBuilder(MAX_BATCH_BYTES);
            sb.append("{\"events\":[");
            for (int i = 0; i < batch.serializedEntries.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append(batch.serializedEntries.get(i));
            }
            sb.append("]}");

            byte[] postData = sb.toString().getBytes(StandardCharsets.UTF_8);
            if (postData.length > MAX_BATCH_BYTES && batch.ids.size() > 1) {
                maxBatchCount = Math.max(1, batch.ids.size() / 2);
                continue;
            }

            boolean batchSent = false;
            int targets413Count = 0;
            int targetsValidationRejectCount = 0;
            int lastValidationCode = 400;
            boolean cancellationInterrupted = false;

            for (int i = 0; i < targets.size(); i++) {
                if (run.cancelled) {
                    cancellationInterrupted = true;
                    break;
                }
                Target target = targets.get(i);
                boolean isProbe = targets.size() > 1 && i == 0 && "lan".equals(target.mode);
                int timeoutMs = isProbe ? 3000 : 8000;
                HttpURLConnection conn = null;

                try {
                    URL url = new URL(target.baseUrl + "/mobile/usage-report");
                    conn = (HttpURLConnection) url.openConnection();
                    run.activeConnection = conn;
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(timeoutMs);
                    conn.setReadTimeout(timeoutMs);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("Authorization", "Bearer " + target.token);
                    conn.setRequestProperty("User-Agent", "Pieces-Android-NativeSync/1.0");
                    conn.setDoOutput(true);

                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(postData);
                        os.flush();
                    }

                    int responseCode = conn.getResponseCode();
                    if (responseCode >= 200 && responseCode < 300) {
                        batchSent = true;
                        maxBatchCount = BATCH_SIZE;
                        break;
                    }

                    if (responseCode == 413) {
                        targets413Count++;
                        continue; // Try next target before concluding 413
                    }

                    if (responseCode == 400 || responseCode == 422) {
                        targetsValidationRejectCount++;
                        lastValidationCode = responseCode;
                        continue; // Validation/schema rejection
                    }

                    if (responseCode == 401 || responseCode == 403 || responseCode == 429 || responseCode >= 500) {
                        continue; // Transient: auth token refresh, rate limit, or server error
                    }

                    if (responseCode >= 400 && responseCode < 500) {
                        Log.w(TAG, "Target " + target.baseUrl + " returned HTTP " + responseCode + "; trying next target.");
                        continue;
                    }
                } catch (Exception e) {
                    // Timeout, connection refused, or cancelled via disconnectActive()
                } finally {
                    run.activeConnection = null;
                    if (conn != null) {
                        conn.disconnect();
                    }
                }
            }

            if (batchSent) {
                boolean purged = purgeSentEventsById(context, batch.ids);
                if (!purged) {
                    lastFailureElapsed = SystemClock.elapsedRealtime();
                    scheduleRetry(context, MIN_RETRY_INTERVAL_MS, run);
                    return FlushOutcome.FAILED;
                }
                lastFailureElapsed = 0;
                if (run.cancelled) {
                    return FlushOutcome.CANCELLED;
                }
                continue;
            }

            if (cancellationInterrupted || run.cancelled) {
                return FlushOutcome.CANCELLED;
            }

            // Multi-item batch can shrink if ANY target returned 413
            if (targets413Count > 0 && batch.ids.size() > 1) {
                maxBatchCount = Math.max(1, batch.ids.size() / 2);
                continue;
            }

            // Multi-item batch can shrink if ALL configured targets rejected with 400/422 validation failure
            if (targetsValidationRejectCount > 0 && targetsValidationRejectCount == targets.size() && batch.ids.size() > 1) {
                maxBatchCount = Math.max(1, batch.ids.size() / 2);
                continue;
            }

            // Singleton quarantine: ALL configured targets must have definitively rejected with 413
            if (targets413Count > 0 && targets413Count == targets.size() && batch.ids.size() == 1) {
                Log.w(TAG, "Single event rejected with 413 on all targets (" + targets413Count + "/" + targets.size() + "); quarantining: " + batch.ids.get(0));
                boolean quarantined = quarantineAndRemoveEvent(context, batch.ids.get(0), batch.serializedEntries.get(0), "HTTP 413 Payload Too Large on all targets");
                if (!quarantined) {
                    lastFailureElapsed = SystemClock.elapsedRealtime();
                    scheduleRetry(context, MIN_RETRY_INTERVAL_MS, run);
                    return FlushOutcome.FAILED;
                }
                continue;
            }

            // Singleton quarantine: ALL configured targets must have definitively rejected with 400/422
            if (targetsValidationRejectCount > 0 && targetsValidationRejectCount == targets.size() && batch.ids.size() == 1) {
                Log.w(TAG, "Single event rejected with HTTP " + lastValidationCode + " on all targets (" + targetsValidationRejectCount + "/" + targets.size() + "); quarantining: " + batch.ids.get(0));
                boolean quarantined = quarantineAndRemoveEvent(context, batch.ids.get(0), batch.serializedEntries.get(0), "HTTP " + lastValidationCode + " Validation Error on all targets");
                if (!quarantined) {
                    lastFailureElapsed = SystemClock.elapsedRealtime();
                    scheduleRetry(context, MIN_RETRY_INTERVAL_MS, run);
                    return FlushOutcome.FAILED;
                }
                continue;
            }

            // Transient network failure or mixed results: preserve outbox and retry
            lastFailureElapsed = SystemClock.elapsedRealtime();
            scheduleRetry(context, MIN_RETRY_INTERVAL_MS, run);
            return FlushOutcome.FAILED;
        }

        return FlushOutcome.CANCELLED;
    }

    private static void scheduleRetry(Context context, long delayMs, FlushRun run) {
        synchronized (FLUSH_LOCK) {
            if (run != null && (run.cancelled || run.epoch != currentEpoch)) {
                Log.d(TAG, "Ignoring scheduleRetry for stale/cancelled run (run.epoch=" + run.epoch + ", currentEpoch=" + currentEpoch + ")");
                return;
            }
            if (scheduledRetry != null && !scheduledRetry.isDone()) {
                return; // Coalesce into existing active retry timer under unified FLUSH_LOCK
            }
            final long epoch = currentEpoch;
            long delay = Math.max(1000, delayMs);
            scheduledRetry = RETRY_SCHEDULER.schedule(() -> {
                flushInternalStart(context, true, null, epoch, null);
            }, delay, TimeUnit.MILLISECONDS);
        }
    }

    /**
     * Atomically moves an event to the quarantine table and removes it from the outbox
     * in a single SQLite transaction.
     */
    private static boolean quarantineAndRemoveEvent(Context context, String id, String payload, String reason) {
        if (!ensureInitialized(context) || readyDb == null) {
            Log.e(TAG, "Cannot quarantine event; database not ready: " + id);
            return false;
        }
        try {
            SQLiteDatabase db = readyDb;
            db.beginTransaction();
            try {
                ContentValues cv = new ContentValues();
                cv.put("id", id);
                cv.put("payload", payload);
                cv.put("reason", reason);
                cv.put("created_at", System.currentTimeMillis());
                long inserted = db.insertWithOnConflict(TABLE_QUARANTINE, null, cv, SQLiteDatabase.CONFLICT_REPLACE);
                if (inserted == -1) {
                    throw new SQLiteException("Quarantine insert failed");
                }

                db.delete(TABLE_OUTBOX, "id = ?", new String[]{id});

                long count = DatabaseUtils.queryNumEntries(db, TABLE_QUARANTINE);
                if (count > MAX_QUARANTINE_EVENTS) {
                    db.execSQL("DELETE FROM " + TABLE_QUARANTINE + " WHERE seq NOT IN ("
                            + "SELECT seq FROM " + TABLE_QUARANTINE + " ORDER BY seq DESC LIMIT " + MAX_QUARANTINE_EVENTS + ")");
                }
                db.setTransactionSuccessful();
                return true;
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed atomic quarantine and remove for " + id, e);
            return false;
        }
    }

    /**
     * Atomically purges events by their unique IDs in a single SQLite transaction.
     */
    private static boolean purgeSentEventsById(Context context, List<String> sentIds) {
        if (sentIds == null || sentIds.isEmpty()) return true;
        if (!ensureInitialized(context) || readyDb == null) {
            Log.e(TAG, "Cannot purge events; database not ready");
            return false;
        }
        try {
            SQLiteDatabase db = readyDb;
            db.beginTransaction();
            try {
                StringBuilder inClause = new StringBuilder("?");
                for (int i = 1; i < sentIds.size(); i++) {
                    inClause.append(",?");
                }
                db.delete(TABLE_OUTBOX, "id IN (" + inClause + ")", sentIds.toArray(new String[0]));
                db.setTransactionSuccessful();
                return true;
            } finally {
                db.endTransaction();
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to purge sent events from SQLite outbox", e);
            return false;
        }
    }
}
