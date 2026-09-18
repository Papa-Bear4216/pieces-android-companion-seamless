# pieces-android: Fork Reconciliation & Merge Plan

**Status:** COMPLETED & VERIFIED (2026-09-18)  
**Target:** Unified codebase combining on-device semantic search (`shizuku-fix`) with automatic Plan A/B remote gateway failover (`shizuku-monitor`).

---

## 1. Executive Summary & Divergence State

The two active working directories branched from common ancestor `f100d9e`:
1. **`pieces-android-shizuku-fix`** (Branch: `shizuku-master` on Desktop):
   - **Exclusive Capabilities:**
     - On-device vector embeddings with MediaPipe (`TextEmbedderPlugin.java`, `textEmbedder.ts`).
     - Local SQLite/file vector indexing and month-sharded search (`captureIndex.ts`, `semanticSearch.ts`).
     - Local semantic search user interface (`Search.tsx`, `Search.test.tsx`).
     - On-device Gemini Nano triage loop (`onDeviceTriage.ts`, `triageQueue.ts`).
     - Safe triage-prefix queue stop condition in `flush.ts`.
     - Full Vitest test suite (`vitest run` with 36/36 tests passing).
   - **Missing:** Automatic Plan A (LAN) to Plan B (Remote Hermes Gateway) failover; uses single proxy baseUrl/token.

2. **`pieces-android-shizuku-monitor`** (Branch: `master` on OneDrive Desktop):
   - **Exclusive Capabilities:**
     - Multi-target connectivity (`config.ts` with `getConnectionTargets()`, `REMOTE_GATEWAY_*`).
     - Dynamic LAN to Remote failover loop in `flush.ts`.
     - Hardened `authedFetch` failover on 401/403/5xx (`578a29c`).
     - Mem0 telemetry seeding support in proxy.
   - **Missing:** Entire semantic search stack, on-device triage loop, and triage-prefix safety gate.

---

## 2. Component Conflict & Merge Matrix

| File / Component | `shizuku-fix` | `shizuku-monitor` | Resolution Strategy |
|---|---|---|---|
| **`flush.ts`** | Triage-prefix gating, single target | Multi-target failover loop, raw unconditional flush | **HARD CONFLICT — Hand-merge required.** Combine multi-target loop + triage prefix stop + async mutex + ID-based clearing (see §3). |
| **`usage.ts`** | Added `triaged?` field, `replaceQueue` | Added `app_label?` field | **Mechanical merge.** Combine types (`triaged?`, `app_label?`, `id?: string`). Add `withQueueLock`, ID-based `clearSentEvents`, and `patchTriagedEvents`. |
| **`config.ts`** | Standard proxy config | Multi-target config (`getConnectionTargets`) | **Additive (one-sided).** Adopt `shizuku-monitor`'s multi-target configuration. |
| **`api.ts`** | Standard single-target fetch | Multi-target failover `authedFetch` with 401/403/5xx retry | **Additive.** Adopt `shizuku-monitor`'s `api.ts` with commit `578a29c`. |
| **`semanticSearch/` stack** | Complete & tested | None | **Clean drop-in.** Copy `semanticSearch.ts`, `captureIndex.ts`, `textEmbedder.ts`, `onDeviceTriage.ts`, `triageQueue.ts`, and `Search.tsx` directly into the merged repo. |
| **`proxy/` & `gateway/`** | Standard proxy scripts | Gateway auth & Mem0 proxy | **Additive.** Retain gateway and merge proxy enhancements. |

---

## 3. The Unified `flush.ts` Specification

`flush.ts` must resolve three requirements simultaneously:
1. **Privacy Guard (from `fix`)**: Never transmit raw untriaged background captures over the network. Stop at the first untriaged background capture.
2. **Resilience & Failover (from `monitor`)**: Attempt fast LAN delivery (2.5s timeout); on failure or disconnect, fall back to the remote gateway.
3. **Queue Integrity (ORION Claim 1)**: Wrap the peek to send to clear sequence in an async mutex (`isFlushing`) and clear events by unique `id`, not by integer count slice.

### Canonical Unified Implementation:

```typescript
import { getConnectionTargets } from "./config";
import { peekQueue, clearSentEvents, type UsageEvent } from "./usage";

let isFlushing = false;

/**
 * Best-effort batch flush of queued usage events with auto-failover.
 * - Stops before any untriaged background capture to prevent raw screen text leaks.
 * - Probes LAN proxy first (2.5s timeout); falls back to remote gateway.
 * - Protected by an async mutex flag to eliminate concurrent slice races.
 * - Clears sent events by unique ID, preserving newly arrived events.
 */
export async function flushUsageEvents(): Promise<void> {
  if (isFlushing) return;
  isFlushing = true;

  try {
    const events = await peekQueue();
    if (events.length === 0) return;

    // 1. Triage-prefix gating: only send events up to the first untriaged capture
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

    // 2. Connection targets with failover
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
          body: JSON.stringify({ events: toSend }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.ok) {
          // Clear only the specific sent events by ID
          await clearSentEvents(toSend);
          return;
        }

        // On 401/403 or 5xx, continue loop to try next target (gateway)
        if (res.status === 401 || res.status === 403 || res.status >= 500) {
          continue;
        }
      } catch {
        // Network timeout / unreachability on LAN falls back to gateway
      }
    }
  } catch {
    // Best-effort telemetry: silently retry on next flush
  } finally {
    isFlushing = false;
  }
}
```

---

## 4. Queue Concurrency Hardening in `usage.ts`

### 4.1 Root Causes of Telemetry Defects:
- **Claim 1 (Queue Inflation & Loss)**: `clearSentEvents(sentCount)` did `queue.slice(sentCount)`. If 3 new events arrived while network POST was in flight, slicing by `sentCount` dropped the 3 new events.
- **Claim 2 (Triage Queue Clobber)**: `triageQueue()` read `const queue = await peekQueue()`, spent 10–30 seconds running on-device inference, and then called `replaceQueue(queue)`. Any events appended during the 30 seconds were completely erased.
- **RMW Race**: `recordEvent` read the queue and wrote it back without synchronization.

### 4.2 Hardening Architecture:
1. **FIFO Async Mutex (`withQueueLock`)**: Serializes all operations modifying the storage array.
2. **Stable Unique ID Assignment**: Every event receives an `id` (`${Date.now()}-${Math.random().toString(36).slice(2, 9)}`) on creation.
3. **ID-Based Deletion**: `clearSentEvents(eventsToRemove)` uses a `Set<string>` of sent IDs to filter the queue.
4. **Targeted In-Place Patching**: New `patchTriagedEvents(updated)` matches by event ID and updates only the triaged fields without overwriting unrelated items appended during inference.

---

## 5. Step-by-Step Merge Execution Checklist

1. [x] **Consolidate Canonical Git Root**:
   - `C:\Users\micha\projects\pieces-android-shizuku-fix` on `master` is verified as the canonical unified repository.
   - `shizuku-master` branch verified as an ancestor of `master`.
2. [x] **Import Non-Conflicting Assets**:
   - `config.ts` (multi-target connection) verified.
   - `api.ts` (`authedFetch` failover) verified.
   - `semanticSearch/`, `captureIndex/`, `textEmbedder/`, `triageQueue/`, and `Search.tsx` intact.
3. [x] **Apply Hardened `flush.ts` and `usage.ts`**:
   - Canonical `flush.ts` implemented with `isFlushing` mutex and triage prefix stop.
   - `withQueueLock`, ID-based `clearSentEvents`, and `patchTriagedEvents` implemented in `usage.ts`.
4. [x] **Validate Test Suite**:
   - Vitest: 6 test files, 45 tests passing.
   - Production build: `npm --prefix apps/mobile run build` (`tsc -b && vite build`) passing cleanly.

