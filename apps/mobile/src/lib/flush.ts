import { getConnectionTargets } from "./config";
import { peekQueue, clearSentEvents } from "./usage";

// Best-effort batch flush of queued usage events. Never throws — telemetry
// must never surface an error to the UI or affect HomeNodeUnreachableError
// handling on the screens driving real user actions.
//
// Two things, merged from the two forks:
//
//  1. (from shizuku-fix) Only ever sends a PREFIX of the queue up to (not
//     including) the first untriaged background capture — never the whole
//     queue unconditionally. This is what keeps raw captured screen text /
//     notification / SMS bodies off the wire until triageQueue.ts has
//     summarized them on-device. Every screen calls this to flush its own
//     screen_view/ask/setup_saved events promptly without caring whether a
//     triage pass has run; triageQueue.ts calls it too, after rewriting
//     entries, by which point there's no untriaged prefix left to stop at.
//
//  2. (from shizuku-monitor) Plan A (LAN) -> Plan B (remote gateway)
//     failover: try each target in order, move on for a network error /
//     timeout / 401 / 403 / 5xx.

let isFlushing = false;

// Best-effort batch flush of queued usage events with auto-failover.
// Tries LAN proxy first; if disconnected/away from home, falls back to remote gateway.
export async function flushUsageEvents(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    // Stop at the first untriaged background capture — send only what's ready.
    let sendCount = events.length;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (e.type === "system_telemetry" && e.screen === "background" && e.triaged === undefined) {
        sendCount = i;
        break;
      }
    }
    if (sendCount === 0) return;
    const toSend = events.slice(0, sendCount);

    const targets = await getConnectionTargets();
    if (targets.length === 0) return;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const probe = targets.length > 1 && i === 0 && target.mode === "lan";
      const timeoutMs = probe ? 2500 : 8000;

      try {
        const res = await fetch(`${target.baseUrl}/mobile/usage-report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.token}`,
          },
          body: JSON.stringify({ events: toSend }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          await clearSentEvents(toSend);
          return;
        }
        // Stale token for this profile, or server error — the other profile
        // may still work. Anything else (404, 400…) won't be fixed by
        // failover, so stop and leave the queue for the next attempt.
        if (res.status === 401 || res.status === 403 || res.status >= 500) continue;
        return;
      } catch {
        // Network error / timeout — try the next target (e.g. Plan B gateway).
      }
    }
    // All targets failed: queue stays intact for the next flush call.
    const targets = await getConnectionTargets();
    if (targets.length === 0) return;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const timeoutMs = targets.length > 1 && i === 0 && target.mode === "lan" ? 2500 : 8000;

      try {
        const res = await fetch(`${target.baseUrl}/mobile/usage-report`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${target.token}`,
          },
          body: JSON.stringify({ events }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          await clearSentEvents(events.length);
          return;
        }
      } catch {
        // Fall back to next target (e.g. Plan B gateway)
      }
    }
  } catch {
    // Network error, offline, whatever — silently retry on the next flush call.
  } finally {
    isFlushing = false;
  }
}
