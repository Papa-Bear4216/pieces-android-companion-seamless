import { peekQueue, patchTriagedEvents, type UsageEvent } from "./usage";
import { flushUsageEvents } from "./flush";
import { tryOnDeviceTriage } from "./onDeviceTriage";
import { embed } from "./textEmbedder";
import { appendEntry } from "./captureIndex";

// Runs the on-device triage pass over any queued background captures that
// haven't been triaged yet, then flushes. Call this on app foreground
// (App.tsx mount) — that's the ONLY time AICore was found to actually run
// inference (see passiveCapture.ts's comment). A background capture can sit
// in the queue raw for anywhere from seconds to days depending on how often
// the app is opened; triage always catches up before anything is sent.
//
// Deliberately sequential, not parallel — each real inference call takes
// ~2-3s, and OnDeviceTriagePlugin's own in-flight guard would just drop
// concurrent calls anyway. A large backlog triages slowly but correctly,
// which is the right tradeoff over dropping summaries under load.
export async function triageQueue(): Promise<void> {
  const queue = await peekQueue();
  const updated: UsageEvent[] = [];

  for (let i = 0; i < queue.length; i++) {
    const event = queue[i];
    if (event.type !== "system_telemetry" || event.screen !== "background") continue;
    if (event.triaged !== undefined) continue; // already attempted, success or fallback
    if (event.telemetry?.startsWith("SMS ")) continue;

    const triaged = await tryOnDeviceTriage(event.app_label ?? "", extractRawText(event.telemetry));
    if (triaged.ok) {
      const rewritten: UsageEvent = {
        ...event,
        telemetry: `Package: ${event.package ?? ""}\n\n[on-device summary] ${triaged.summary} (${triaged.category})`,
        triaged: true,
      };
      updated.push(rewritten);

      // Also persist the summary to the searchable capture index (survives
      // the flush-and-delete cycle below). Embedding failure is non-fatal —
      // the entry just isn't indexed, exactly like a triage fallback.
      const emb = await embed(triaged.summary);
      if (emb.ok) {
        await appendEntry({
          id: `local:${event.timestamp}`,
          text: triaged.summary,
          vector: emb.vector,
          timestamp: event.timestamp,
          source: "local",
          app_label: event.app_label,
        });
      }
    } else {
      updated.push({ ...event, triaged: false });
    }
  }

  if (updated.length > 0) {
    await patchTriagedEvents(updated);
  }

  // flushUsageEvents() itself now stops at the first untriaged background
  // capture (see flush.ts) — so any OTHER call site (every screen's own
  // mount-time flush, App.tsx's interval) is already safe to call without
  // going through this module at all. This call just means "don't wait for
  // the next flush trigger" once triage has actually made progress.
  await flushUsageEvents();
}

// telemetry is stored as "Package: <pkg>\n\n<raw text>" — strip the header
// back off before handing it to the model, matching what passiveCapture.ts
// used to pass inline before the deferred redesign.
function extractRawText(telemetry: string): string {
  const idx = telemetry.indexOf("\n\n");
  return idx === -1 ? telemetry : telemetry.slice(idx + 2);
}
