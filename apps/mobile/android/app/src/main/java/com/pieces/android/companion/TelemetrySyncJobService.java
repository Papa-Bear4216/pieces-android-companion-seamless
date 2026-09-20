package com.pieces.android.companion;

import android.app.job.JobParameters;
import android.app.job.JobService;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Persistent JobScheduler service for Native Telemetry Sync.
 * Drains SQLite outbox in the background across process restarts under network constraints.
 * Serializes completion and cancellation on the main looper with generation tokens.
 */
public class TelemetrySyncJobService extends JobService {

    private static final String TAG = "TelemetrySyncJob";
    private final AtomicInteger currentGeneration = new AtomicInteger(0);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile long activeRunId = -1;

    @Override
    public boolean onStartJob(JobParameters params) {
        final int gen = currentGeneration.incrementAndGet();
        Log.d(TAG, "onStartJob triggered; gen=" + gen);

        activeRunId = NativeTelemetrySync.flushJobAsync(getApplicationContext(), (success) -> {
            mainHandler.post(() -> {
                if (currentGeneration.get() != gen) {
                    Log.d(TAG, "Drain finished for obsolete/cancelled gen=" + gen + "; suppressing late jobFinished");
                    return;
                }
                currentGeneration.incrementAndGet();
                Log.d(TAG, "Background sync drain finished; gen=" + gen + ", success=" + success);
                jobFinished(params, !success);
            });
        });
        return true; // Keep execution slot active until drain callback fires
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        int cancelledGen = currentGeneration.incrementAndGet();
        Log.d(TAG, "onStopJob called by system; invalidated gen=" + (cancelledGen - 1));
        long runToCancel = activeRunId;
        if (runToCancel != -1) {
            NativeTelemetrySync.requestCancelFlush(runToCancel);
        }
        return true; // Reschedule if system preempts job before completion
    }
}
