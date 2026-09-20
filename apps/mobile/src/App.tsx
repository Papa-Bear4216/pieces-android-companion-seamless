import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router";
import Setup from "./pages/Setup";
import Status from "./pages/Status";
import Ask from "./pages/Ask";
import Recent from "./pages/Recent";
import Search from "./pages/Search";
import { flushUsageEvents } from "./lib/flush";
import { triageQueue } from "./lib/triageQueue";
import { isShizukuToolkitEnabled, isScreenContextEnabled, isNotificationCaptureEnabled } from "./lib/config";
import { startPassiveCaptureListener } from "./lib/passiveCapture";
import { startNotificationCaptureListener } from "./lib/notificationCapture";
import { runSmsBackfill } from "./lib/smsBackfill";
import { registerPlugin, Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";

const ShizukuMonitor = registerPlugin<any>('ShizukuMonitor');
const AccessibilityScanner = registerPlugin<any>('AccessibilityScanner');

const USAGE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

// HashRouter, not BrowserRouter: Capacitor serves the app from a local
// file/asset origin with no server-side routing, so path-based routes would
// 404 on refresh/deep link. Same class of problem bear-house-classic solved
// with apiUrl() for API calls — this is the routing equivalent.
import Layout from "./components/Layout";

export default function App() {
  const [shizukuOffline, setShizukuOffline] = useState(false);

  useEffect(() => {
    // Re-enable the accessibility service via Shizuku on launch only if it's
    // not already enabled natively, and only for users who opted into Shizuku.
    async function checkShizuku() {
      const enabled = await isShizukuToolkitEnabled();
      if (!enabled) return;

      // If Accessibility is already active in Android Settings, Shizuku is optional.
      try {
        const acc = await AccessibilityScanner.isAccessibilityServiceEnabled();
        if (acc?.enabled) return;
      } catch {}

      try {
        const res = await ShizukuMonitor.checkPermission();
        if (res.status !== "granted") {
          setShizukuOffline(true);
        } else {
          await ShizukuMonitor.enableAccessibilityService();
        }
      } catch {
        setShizukuOffline(true);
      }
    }
    if (Capacitor.isNativePlatform()) checkShizuku();

    // Registered here (app-lifetime), not in Status.tsx (screen-lifetime) —
    // a listener tied to a screen's mount only receives events while that
    // screen happens to be open, defeating passive mode's entire purpose of
    // capturing in the background regardless of which tab is visible. Gated
    // on screen context being enabled at all, same as the native service's
    // own check, so this doesn't register a no-op listener for users who
    // never opted in.
    let removeAppStateListener: (() => void) | undefined;
    isScreenContextEnabled().then((enabled) => {
      if (enabled && Capacitor.isNativePlatform()) {
        startPassiveCaptureListener();
        // Triage the backlog on every app foreground — this is the ONLY
        // time on-device Gemini Nano/AICore was found to actually run
        // inference (see passiveCapture.ts's comment: it refuses while a
        // third-party app is foreground, which is always true during a
        // real capture). Cold mount catches whatever accumulated while the
        // app was closed; the isActive listener below catches whatever
        // accumulates on subsequent resumes within the same install (user
        // backgrounds pieces-android to use another app, more captures
        // queue, then comes back) — mount alone would miss those.
        triageQueue();
        CapacitorApp.addListener("appStateChange", ({ isActive }) => {
          if (isActive) triageQueue();
        }).then((handle) => {
          removeAppStateListener = () => handle.remove();
        });
      }
    });

    // Part 1: notification capture. Independent of screen-context — a user can
    // want the notification firehose without the accessibility screen scraper.
    // The native service also fail-closes on its own pref, so registering here
    // when the flag is off would only wire a listener that never fires.
    isNotificationCaptureEnabled().then((enabled) => {
      if (enabled && Capacitor.isNativePlatform()) {
        startNotificationCaptureListener();
      }
    });

    // Part 2: SMS backfill. One-shot on foreground — catches texts that arrived
    // while the app was closed / phone was off. No-op if READ_SMS isn't granted
    // or the high-water mark is already caught up. Bounded per run (see
    // smsBackfill.ts MAX_PER_RUN); a huge first history resumes across runs.
    if (Capacitor.isNativePlatform()) {
      runSmsBackfill().catch(() => {});
    }

    // Backstop flush for events queued during a long session on one screen
    // (e.g. repeated searches without navigating away) — per-screen mount
    // already flushes on every navigation, this just covers the gap.
    // Deliberately flushUsageEvents, not triageQueue, on this interval:
    // triage only works while foreground anyway (true whenever this
    // interval is running), but re-running a full backlog scan every 5
    // minutes is wasted work when the foreground-mount triageQueue() call
    // above already caught up whatever was pending at open time.
    const id = setInterval(flushUsageEvents, USAGE_FLUSH_INTERVAL_MS);
    return () => {
      clearInterval(id);
      removeAppStateListener?.();
    };
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route
          element={
            <Layout
              shizukuOffline={shizukuOffline}
              onDismissShizuku={() => setShizukuOffline(false)}
            />
          }
        >
          <Route path="/" element={<Navigate to="/setup" replace />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/status" element={<Status />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/recent" element={<Recent />} />
          <Route path="/search" element={<Search />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
