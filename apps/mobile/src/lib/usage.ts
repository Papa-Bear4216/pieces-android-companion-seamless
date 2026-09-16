import { Preferences } from "@capacitor/preferences";

// Local queue of usage events, flushed to /mobile/usage-report by flush.ts.
// Stored in Preferences (not localStorage) for consistency with config.ts,
// and because these events can contain real query/question text — the user
// explicitly chose full detail over anonymized/aggregated tracking.

const QUEUE_KEY = "pieces-android:usageQueue";
const MAX_QUEUE_SIZE = 500; // backstop against unbounded growth if flush stays broken for a long time

export type UsageEvent = (
  | { type: "ask"; screen: "ask"; query: string; result: "answered" | "unavailable" | "error"; timestamp: string }
  | { type: "search"; screen: "recent"; query: string; resultCount: number; mode: "relevant" | "text" | "text-fallback"; timestamp: string }
  | { type: "screen_view"; screen: "setup" | "status" | "recent" | "ask"; timestamp: string }
  | { type: "setup_saved"; screen: "setup"; mode: "lan" | "remote"; timestamp: string }
  | {
      type: "system_telemetry";
      screen: "background";
      telemetry: string;
      package?: string;
      app_label?: string;
      timestamp: string;
      // Set once triageQueue() has attempted this entry — true if it holds
      // an on-device summary, false if triage ran but fell back to raw
      // text. Undefined means "not yet triaged" (the state every passive
      // capture starts in — see passiveCapture.ts, which deliberately does
      // NOT call tryOnDeviceTriage inline anymore since AICore only permits
      // inference while this app is foreground, never true during a real
      // background capture). triageQueue() is the only writer of this field.
      triaged?: boolean;
    }
) & {
  id?: string;
};

// Internal FIFO async lock serializing all queue read-modify-write operations
let queueLock: Promise<void> = Promise.resolve();

async function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const prevLock = queueLock;
  let release: () => void;
  queueLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await prevLock;
    return await fn();
  } finally {
    release!();
  }
}

async function readQueue(): Promise<UsageEvent[]> {
  const { value } = await Preferences.get({ key: QUEUE_KEY });
  if (!value) return [];
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    let backfilled = false;
    const events: UsageEvent[] = raw.map((e) => {
      if (!e || typeof e !== "object") return e;
      if (!e.id) {
        backfilled = true;
        return {
          ...e,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        };
      }
      return e;
    });
    if (backfilled) {
      Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(events) }).catch(() => {});
    }
    return events;
  } catch {
    return [];
  }
}

async function writeQueue(events: UsageEvent[]): Promise<void> {
  await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(events) });
}

export async function recordEvent(event: UsageEvent): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const eventWithId: UsageEvent = {
      ...event,
      id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };
    queue.push(eventWithId);
    if (queue.length > MAX_QUEUE_SIZE) queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    await writeQueue(queue);
  });
}

export async function peekQueue(): Promise<UsageEvent[]> {
  return readQueue();
}

/**
 * Targeted patch for triageQueue: updates matching events in place by id
 * without clobbering events that arrived while inference was in flight.
 */
export async function patchTriagedEvents(updatedEvents: UsageEvent[]): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const idMap = new Map<string, UsageEvent>();
    const tsMap = new Map<string, UsageEvent>();
    for (const u of updatedEvents) {
      if (u.id) idMap.set(u.id, u);
      else if (u.timestamp) tsMap.set(`${u.type}:${u.timestamp}`, u);
    }
    for (let i = 0; i < queue.length; i++) {
      const existing = queue[i];
      if (existing.id && idMap.has(existing.id)) {
        queue[i] = idMap.get(existing.id)!;
      } else if (existing.timestamp && tsMap.has(`${existing.type}:${existing.timestamp}`)) {
        queue[i] = tsMap.get(`${existing.type}:${existing.timestamp}`)!;
      }
    }
    await writeQueue(queue);
  });
}

/** Overwrites the whole queue in place under lock (for backward compatibility). */
export async function replaceQueue(events: UsageEvent[]): Promise<void> {
  return withQueueLock(async () => {
    await writeQueue(events);
  });
}

/** Removes sent events by ID or type/timestamp fingerprint. Only call after a confirmed 2xx report. */
export async function clearSentEvents(sent: Array<string | UsageEvent> | number): Promise<void> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    if (typeof sent === "number") {
      // Backward compatibility slice
      await writeQueue(queue.slice(sent));
      return;
    }

    const idsToRemove = new Set<string>();
    const fingerprintsToRemove = new Set<string>();

    for (const item of sent) {
      if (typeof item === "string") {
        idsToRemove.add(item);
      } else if (item && typeof item === "object") {
        if (item.id) idsToRemove.add(item.id);
        if (item.type && item.timestamp) {
          fingerprintsToRemove.add(`${item.type}:${item.timestamp}`);
        }
      }
    }

    if (idsToRemove.size === 0 && fingerprintsToRemove.size === 0) {
      // If none had ids or fingerprints, slice by count of sent items as fallback
      await writeQueue(queue.slice(sent.length));
      return;
    }

    const remaining = queue.filter((e) => {
      if (e.id && idsToRemove.has(e.id)) return false;
      if (e.type && e.timestamp && fingerprintsToRemove.has(`${e.type}:${e.timestamp}`)) return false;
      return true;
    });

    await writeQueue(remaining);
  });
}

export function classifyMode(baseUrl: string): "lan" | "remote" {
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(baseUrl) ? "lan" : "remote";
}
