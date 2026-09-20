import { Capacitor, registerPlugin } from "@capacitor/core";
import { recordEvent } from "./usage";

const AccessibilityScanner = registerPlugin<any>("AccessibilityScanner");

export type LastPassiveCapture = { pkg: string; at: string };

// Registered once from App.tsx (mounted for the app's entire lifetime), not
// from Status.tsx — a listener tied to a screen's component lifecycle only
// receives captures while that screen happens to be open, which defeats the
// entire point of "passive" mode running in the background regardless of
// which tab is visible.
let started = false;
let lastCapture: LastPassiveCapture | null = null;
const subscribers = new Set<(capture: LastPassiveCapture) => void>();

export function onPassiveCapture(cb: (capture: LastPassiveCapture) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getLastPassiveCapture(): LastPassiveCapture | null {
  return lastCapture;
}

export function startPassiveCaptureListener(): void {
  if (started) return;
  started = true;

  // On native Android, PiecesAccessibilityService automatically writes debounced
  // captures to the native durable outbox (telemetry_outbox.jsonl) and flushes them
  // asynchronously in the background. When this companion app UI is open,
  // the event also arrives here to update the live UI status.
  AccessibilityScanner.addListener("passiveCapture", async (data: { package: string; appLabel: string; textNodes: string }) => {
    const timestamp = new Date().toISOString();

    if (!Capacitor.isNativePlatform()) {
      await recordEvent({
        type: "system_telemetry",
        screen: "background",
        telemetry: `Package: ${data.package}\n\n${data.textNodes}`,
        package: data.package,
        app_label: data.appLabel,
        timestamp,
      });
    }

    lastCapture = { pkg: data.package, at: timestamp };
    for (const cb of subscribers) cb(lastCapture);
  });
}
