package com.pieces.android.companion;

import android.accessibilityservice.AccessibilityService;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class PiecesAccessibilityService extends AccessibilityService {

    // A static buffer to hold the most recently extracted text blocks across the OS
    public static List<String> lastCapturedText = new ArrayList<>();
    public static String lastCapturedPackage = "";

    // Debounce settle time for passive mode: wait this long after the last
    // accessibility event before treating the screen as "settled" and
    // considering a push. Avoids firing on every keystroke/scroll.
    private static final long DEBOUNCE_MS = 2000;

    // Bounds on extractText: without these, a deeply nested or huge webview
    // tree produces an unbounded string that gets hashed and pushed whole.
    private static final int MAX_NODE_DEPTH = 40;
    private static final int MAX_TEXT_CHARS = 20_000;

    // How many recent (package, hash) pushes to remember per debounce cycle.
    // A single "last pushed" value is defeated by flicker between two states
    // (e.g. bouncing between two scroll positions); a small ring buffer
    // catches repeats within a short recent window instead of just the
    // immediately-previous one.
    private static final int DEDUPE_HISTORY_SIZE = 15;

    private final Handler debounceHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPush;
    private final Deque<String> recentPushHashes = new ArrayDeque<>(DEDUPE_HISTORY_SIZE);

    // Set by AccessibilityPlugin when the JS layer wants passive-mode pushes
    // delivered as they're debounced, instead of only on-demand via
    // getActiveScreenText(). Null when nobody's listening (e.g. plugin not
    // yet initialized) — pushes are simply skipped, buffer still updates.
    public interface PassiveCaptureListener {
        void onCapture(String packageName, String text);
    }
    public static volatile PassiveCaptureListener passiveListener;

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getSource() == null) return;

        // Master switch mirrored from the JS-side Setup toggle (config.ts's
        // screenContextEnabled) — fail-closed if the flag has never been
        // written, so a fresh install captures nothing until explicitly
        // opted in from Setup, not just because Accessibility is granted.
        if (!isScreenContextEnabled()) return;

        // Never capture off the lock screen — notification previews (SMS,
        // email, chat) render as real accessibility content there even
        // though the user hasn't unlocked or interacted with anything.
        if (isLocked()) return;

        String packageName = event.getPackageName() != null ? event.getPackageName().toString() : "";
        if (!isAllowed(packageName)) return;

        AccessibilityNodeInfo rootNode = event.getSource();
        List<String> extractedTexts = new ArrayList<>();
        try {
            extractText(rootNode, extractedTexts, 0, new int[]{0}, new boolean[]{false});
        } finally {
            rootNode.recycle();
        }

        if (extractedTexts.isEmpty()) return;

        lastCapturedPackage = packageName;
        lastCapturedText = extractedTexts;

        if (isPassiveModeEnabled()) {
            scheduleDebouncedPush(packageName, String.join("\n", extractedTexts));
        }
    }

    private void scheduleDebouncedPush(String packageName, String text) {
        if (pendingPush != null) debounceHandler.removeCallbacks(pendingPush);
        pendingPush = () -> {
            // Dedupe against a normalized hash rather than the raw string, and
            // against a small recent-history window rather than only the last
            // push — scrolling shifts whitespace/ordering without changing
            // content, and flicker between two states defeats a single-value
            // comparison.
            String hash = normalizedHash(packageName, text);
            if (recentPushHashes.contains(hash)) return;
            recentPushHashes.addLast(hash);
            while (recentPushHashes.size() > DEDUPE_HISTORY_SIZE) recentPushHashes.removeFirst();

            String appLabel = labelCache.get(packageName);
            if (appLabel == null) appLabel = packageName;

            // Native durable outbox + background HTTP sync (runs independently of whether UI app is open)
            NativeTelemetrySync.queueScreenCapture(PiecesAccessibilityService.this, packageName, appLabel, text);

            PassiveCaptureListener listener = passiveListener;
            if (listener != null) listener.onCapture(packageName, text);
        };
        debounceHandler.postDelayed(pendingPush, DEBOUNCE_MS);
    }

    // Collapses whitespace and sorts text nodes so that content re-ordering
    // (e.g. list items shifting position during scroll) doesn't produce a
    // different hash for what is semantically the same screen content.
    private static String normalizedHash(String packageName, String text) {
        String[] lines = text.split("\n");
        for (int i = 0; i < lines.length; i++) {
            lines[i] = lines[i].trim().replaceAll("\\s+", " ");
        }
        Arrays.sort(lines);
        String normalized = packageName + "|" + String.join("\n", lines);

        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hashBytes = digest.digest(normalized.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : hashBytes) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            // SHA-256 is guaranteed available on Android; this is unreachable
            // in practice. Fall back to the normalized string itself so
            // dedup still functions rather than throwing.
            return normalized;
        }
    }

    private boolean isLocked() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km == null || km.isKeyguardLocked();
    }

    private boolean isScreenContextEnabled() {
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(AccessibilityPlugin.SCREEN_CONTEXT_ENABLED_KEY, false);
    }

    private boolean isPassiveModeEnabled() {
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        return prefs.getBoolean(AccessibilityPlugin.PASSIVE_MODE_KEY, false);
    }

    // Small cache so the label-based exclusion check (see isExcluded's comment
    // on why label matters, not just package id) doesn't do a fresh
    // PackageManager lookup on every single accessibility event — app
    // identity/label doesn't change at runtime, so caching by package name is
    // safe. Unbounded growth isn't a real concern: bounded by how many
    // distinct packages actually fire accessibility events on the device.
    private final java.util.Map<String, String> labelCache = new java.util.HashMap<>();

    // Only capture from packages the user explicitly selected via the app picker
    // (AccessibilityPlugin.setAllowlist) — this service is system-wide by platform
    // design (any app can fire a window event), so this check is the only thing
    // standing between "capture text from whatever's on screen" and "capture text
    // from apps the user actually opted into."
    private boolean isAllowed(String packageName) {
        if (packageName.isEmpty()) return false;
        // Hard denylist enforced independently of the user's saved allowlist —
        // see AccessibilityPlugin.isExcluded's comment for why this can't just
        // rely on the picker/setAllowlist having filtered these out already.
        // Label included here (not just package id) so this stays the actual
        // last line of defense rather than repeating the same prefix-only gap
        // that let com.wf.wellsfargomobile through at save time.
        String label = labelCache.get(packageName);
        if (label == null && !labelCache.containsKey(packageName)) {
            try {
                android.content.pm.PackageManager pm = getPackageManager();
                label = pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString();
            } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}
            labelCache.put(packageName, label);
        }
        if (AccessibilityPlugin.isExcluded(packageName, label)) return false;
        SharedPreferences prefs = getSharedPreferences(AccessibilityPlugin.PREFS_NAME, MODE_PRIVATE);
        Set<String> allowlist = prefs.getStringSet(AccessibilityPlugin.ALLOWLIST_KEY, new HashSet<>());
        return allowlist.contains(packageName);
    }

    // depth and charBudget[0] bound worst-case cost against deeply nested or
    // huge trees (e.g. a long webview) — without this, extractText has no
    // limit on recursion depth or total captured text size.
    //
    // Each captured string is tagged with a coarse role so the server side
    // (summarizeTelemetry) can build a structured block instead of a flat
    // dump. Role is inferred from what AccessibilityNodeInfo actually
    // exposes — there's no true "screen title" API, so the heuristic is:
    // the first non-clickable text encountered (shallow, tree-walk order)
    // is the title; anything clickable is a button; everything else is
    // plain text. Format: "role|text", one per line — '|' is not filtered
    // out of user text, so downstream parsing only trusts the first '|'.
    private void extractText(AccessibilityNodeInfo node, List<String> texts, int depth, int[] charBudget, boolean[] titleFound) {
        if (node == null || depth > MAX_NODE_DEPTH || charBudget[0] >= MAX_TEXT_CHARS) return;

        boolean clickable = node.isClickable();

        if (node.getText() != null && node.getText().length() > 0) {
            String value = node.getText().toString();
            String role = clickable ? "button" : (!titleFound[0] ? "title" : "text");
            if (role.equals("title")) titleFound[0] = true;
            texts.add(role + "|" + value);
            charBudget[0] += value.length();
        }
        if (node.getContentDescription() != null && node.getContentDescription().length() > 0) {
            String value = node.getContentDescription().toString();
            String role = clickable ? "button" : "text";
            texts.add(role + "|" + value);
            charBudget[0] += value.length();
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            extractText(child, texts, depth + 1, charBudget, titleFound);
            if (child != null) child.recycle();
        }
    }

    @Override
    public void onInterrupt() {
        // Required method, ignored for now
    }

    private static final long PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    private final Handler syncHandler = new Handler(Looper.getMainLooper());
    private final Runnable periodicSyncRunnable = new Runnable() {
        @Override
        public void run() {
            NativeTelemetrySync.flushAsync(PiecesAccessibilityService.this);
            syncHandler.postDelayed(this, PERIODIC_SYNC_INTERVAL_MS);
        }
    };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        NativeTelemetrySync.warmUpDatabaseAsync(this);
        NativeTelemetrySync.flushAsync(this);
        syncHandler.postDelayed(periodicSyncRunnable, PERIODIC_SYNC_INTERVAL_MS);
    }

    @Override
    public void onDestroy() {
        syncHandler.removeCallbacks(periodicSyncRunnable);
        super.onDestroy();
    }
}

