import { Capacitor, registerPlugin } from "@capacitor/core";
import { recordEvent } from "./usage";

const NotificationCapture = registerPlugin<any>("NotificationCapture");

export type LastNotificationCapture = { pkg: string; appLabel: string; at: string };

// Registered once from App.tsx (app-lifetime), same reasoning as
// passiveCapture.ts: a listener tied to a screen's mount only fires while that
// screen is open, which defeats a background capture stream.
let started = false;
let lastCapture: LastNotificationCapture | null = null;
const subscribers = new Set<(c: LastNotificationCapture) => void>();

export function onNotificationCapture(cb: (c: LastNotificationCapture) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getLastNotificationCapture(): LastNotificationCapture | null {
  return lastCapture;
}

export function startNotificationCaptureListener(): void {
  if (started) return;
  started = true;

  // On native Android, NotificationCaptureService automatically writes notification
  // events to the native durable outbox (telemetry_outbox.jsonl) and flushes them
  // asynchronously in the background. When this companion app UI is open,
  // the event also arrives here to update the live UI status.
  NotificationCapture.addListener(
    "notification",
    async (data: { package: string; appLabel: string; title: string; text: string; postedAt: number }) => {
      const timestamp = data.postedAt
        ? new Date(data.postedAt).toISOString()
        : new Date().toISOString();

      if (!Capacitor.isNativePlatform()) {
        const titleLine = data.title ? `TITLE: ${data.title}\n` : "";
        await recordEvent({
          type: "system_telemetry",
          screen: "background",
          telemetry: `Notification from ${data.appLabel} (${data.package})\n${titleLine}${data.text}`,
          package: data.package,
          app_label: data.appLabel,
          timestamp,
        });
      }

      lastCapture = { pkg: data.package, appLabel: data.appLabel, at: timestamp };
      for (const cb of subscribers) cb(lastCapture);
    }
  );
}

// --- Setup-screen helpers -------------------------------------------------

export async function isNotificationListenerGranted(): Promise<boolean> {
  try {
    const { enabled } = await NotificationCapture.isListenerEnabled();
    return !!enabled;
  } catch {
    return false;
  }
}

export async function getNotificationCaptureConfig(): Promise<{ enabled: boolean; allApps: boolean }> {
  try {
    const r = await NotificationCapture.getCaptureConfig();
    return { enabled: !!r.enabled, allApps: !!r.allApps };
  } catch {
    return { enabled: false, allApps: false };
  }
}

export async function setNotificationCapture(enabled: boolean, allApps?: boolean): Promise<void> {
  await NotificationCapture.setCaptureEnabled({ enabled, ...(allApps !== undefined ? { allApps } : {}) });
}

export async function openNotificationListenerSettings(): Promise<void> {
  await NotificationCapture.openSettings();
}
