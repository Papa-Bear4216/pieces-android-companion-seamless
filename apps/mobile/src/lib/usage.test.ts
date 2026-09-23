import { beforeEach, describe, expect, test, vi } from "vitest";
import { Preferences } from "@capacitor/preferences";
import { recordEvent, peekQueue, clearSentEvents, type UsageEvent } from "./usage";

const QUEUE_KEY = "pieces-android:usageQueue";

beforeEach(async () => {
  await Preferences.remove({ key: QUEUE_KEY });
  vi.clearAllMocks();
});

describe("usage queue management", () => {
  test("recordEvent adds an event with auto-generated id", async () => {
    await recordEvent({
      type: "search",
      screen: "search",
      query: "movies",
      resultCount: 3,
      mode: "relevant",
      timestamp: "2026-08-31T04:16:56.970Z",
    });

    const queue = await peekQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].type).toBe("search");
    expect(queue[0].id).toBeDefined();
    expect(typeof queue[0].id).toBe("string");
  });

  test("clearSentEvents clears items by id", async () => {
    await recordEvent({
      id: "event-1",
      type: "screen_view",
      screen: "status",
      timestamp: "2026-08-31T04:10:00.000Z",
    });
    await recordEvent({
      id: "event-2",
      type: "search",
      screen: "search",
      query: "test",
      resultCount: 1,
      mode: "relevant",
      timestamp: "2026-08-31T04:11:00.000Z",
    });

    const initial = await peekQueue();
    expect(initial).toHaveLength(2);

    await clearSentEvents(["event-1"]);

    const remaining = await peekQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("event-2");
  });

  test("clearSentEvents clears legacy events lacking IDs using fingerprint", async () => {
    // Simulate legacy queue populated without IDs directly in Preferences
    const legacyQueue: UsageEvent[] = [
      {
        type: "search",
        screen: "search",
        query: "Movie",
        resultCount: 5,
        mode: "relevant",
        timestamp: "2026-08-31T04:16:56.970Z",
      },
      {
        id: "fresh-event-1",
        type: "screen_view",
        screen: "recent",
        timestamp: "2026-08-31T04:20:00.000Z",
      },
    ];
    await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify(legacyQueue) });

    // readQueue backfills missing IDs immediately
    const queue = await peekQueue();
    expect(queue).toHaveLength(2);
    expect(queue[0].id).toBeDefined();

    // Now clear the first event using an event object
    await clearSentEvents([queue[0]]);

    const remaining = await peekQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe("fresh-event-1");
  });

  test("clearSentEvents prevents infinite replay loop for legacy events sent without ID", async () => {
    const rawLegacy: UsageEvent = {
      type: "search",
      screen: "search",
      query: "Movie",
      resultCount: 5,
      mode: "relevant",
      timestamp: "2026-08-31T04:16:56.970Z",
    };
    await Preferences.set({ key: QUEUE_KEY, value: JSON.stringify([rawLegacy]) });

    // Simulate sending the raw legacy object directly without ID
    await clearSentEvents([rawLegacy]);

    const remaining = await peekQueue();
    expect(remaining).toHaveLength(0);
  });
});
