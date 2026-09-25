import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { seedToPiecesOS, seedWorkstreamEvent } from "./seeder.ts";

// Durable store for telemetry that failed to seed into PiecesOS (e.g. it was
// restarting or unreachable) — separate from USAGE_LOG_PATH, which is a
// permanent audit trail and never drained. This file only holds items still
// awaiting a successful seed; entries are removed once the seed succeeds so
// it doesn't grow without bound while PiecesOS is up.
//
// `kind` covers both write targets this proxy seeds into PiecesOS (assets
// and workstream events) so a failed write of either type gets the same
// durable-retry guarantee, instead of only assets having one. `title` is
// asset-only (workstream events have no title field) and is optional so
// existing on-disk queue entries from before this field existed still parse
// — they default to "asset" via the `?? "asset"` fallback in drain().
type PendingSeed = { kind?: "asset" | "workstream_event"; bodyText: string; title?: string; queuedAt: string; attempts: number };

const RETRY_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 50; // ~25 minutes of retrying before giving up on an item

export class SeedQueue {
  private readonly queuePath: string;
  private readonly piecesBaseUrl: string;
  private draining = false;
  private fileOperations: Promise<void> = Promise.resolve();

  constructor(queuePath: string, piecesBaseUrl: string) {
    this.queuePath = queuePath;
    this.piecesBaseUrl = piecesBaseUrl;
  }

  /**
   * Serialize file read-modify-write cycles so a concurrent enqueue() can't
   * clobber drain()'s final write (or vice versa) — both do readAll() then
   * writeAll(), and without a lock the loser silently drops queue entries.
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.fileOperations;
    let release!: () => void;
    this.fileOperations = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Append one failed seed attempt to the durable queue — unless a
   * near-identical entry is already pending. Without this, an outage during
   * a scroll-heavy session queues every surviving (post-dedup) event
   * individually, then replays all of them the moment PiecesOS comes back —
   * a delayed flood rather than a prevented one.
   */
  async enqueue(bodyText: string, title: string, kind: "asset" | "workstream_event" = "asset"): Promise<void> {
    await this.withFileLock(async () => {
    await mkdir(dirname(this.queuePath), { recursive: true });
    const hash = createHash("sha256").update(bodyText).digest("hex");
    const entries = await this.readAll();
    // Same bodyText can legitimately be queued once per kind (the asset
    // write and the workstream-event write for the same capture can fail
    // independently — one succeeding shouldn't suppress retrying the other),
    // so the near-duplicate check is scoped to matching kind, not bodyText
    // alone.
    if (entries.some((e) => (e.kind ?? "asset") === kind && createHash("sha256").update(e.bodyText).digest("hex") === hash)) {
      return;
    }
    const entry: PendingSeed = { kind, bodyText, title, queuedAt: new Date().toISOString(), attempts: 0 };
    await this.writeAll([...entries, entry]);
    });
  }

  private async readAll(): Promise<PendingSeed[]> {
    try {
      const raw = await readFile(this.queuePath, "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as PendingSeed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeAll(entries: PendingSeed[]): Promise<void> {
    // Write to a temp file and rename over the original — avoids a reader
    // (or a crash mid-write) ever seeing a partially-written queue file.
    const tmpPath = `${this.queuePath}.tmp`;
    await mkdir(dirname(this.queuePath), { recursive: true });
    if (entries.length === 0) {
      await writeFile(tmpPath, "", "utf-8");
    } else {
      await writeFile(tmpPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    }
    await rename(tmpPath, this.queuePath);
  }

  /** Try to seed every pending entry; keep only the ones that still fail. */
  async drain(): Promise<{ succeeded: number; remaining: number; dropped: number }> {
    if (this.draining) return { succeeded: 0, remaining: 0, dropped: 0 };
    this.draining = true;
    try {
      const entries = await this.readAll();
      if (entries.length === 0) return { succeeded: 0, remaining: 0, dropped: 0 };

      const stillPending: PendingSeed[] = [];
      let succeeded = 0;
      let dropped = 0;

      for (const entry of entries) {
        try {
          if ((entry.kind ?? "asset") === "workstream_event") {
            await seedWorkstreamEvent(this.piecesBaseUrl, entry.bodyText);
          } else {
            await seedToPiecesOS(this.piecesBaseUrl, entry.bodyText, entry.title ?? "Android Context: System Telemetry");
          }
          succeeded++;
        } catch {
          const attempts = entry.attempts + 1;
          if (attempts >= MAX_ATTEMPTS) {
            // Giving up avoids an unbounded queue if PiecesOS is gone for
            // good (uninstalled, moved) — the original data is still safe
            // in USAGE_LOG_PATH, just not auto-reconciled into PiecesOS.
            dropped++;
            continue;
          }
          stillPending.push({ ...entry, attempts });
        }
      }

      const remaining = await this.withFileLock(async () => {
        // Entries enqueued while the seed attempts above were in flight are
        // appended at the end — merge them in instead of clobbering them.
        const current = await this.readAll();
        const pending = [...stillPending, ...current.slice(entries.length)];
        await this.writeAll(pending);
        return pending.length;
      });
      return { succeeded, remaining, dropped };
    } finally {
      this.draining = false;
    }
  }

  /** Start a background timer that periodically retries pending seeds. */
  startRetryLoop(): void {
    setInterval(() => {
      this.drain()
        .then(({ succeeded, remaining, dropped }) => {
          if (succeeded > 0 || dropped > 0) {
            console.log(
              `[seed-queue] drain: ${succeeded} succeeded, ${remaining} still pending${dropped > 0 ? `, ${dropped} dropped after ${MAX_ATTEMPTS} attempts` : ""}`,
            );
          }
        })
        .catch((err) => console.warn("[seed-queue] drain failed", err));
    }, RETRY_INTERVAL_MS);
  }
}
