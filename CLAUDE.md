# CLAUDE.md — Project Guide & Review Findings

## Overview & Architecture

`pieces-android` is an Android companion client for PiecesOS, providing Status, Recent summaries, semantic search, and an Ask interface, backed by an optional privileged diagnostic and capture toolkit (Shizuku + Android Accessibility + Notification Listener + SMS Backfill).

### Monorepo Structure
- `apps/mobile`: Ionic/React/Capacitor mobile application (`@pieces-android/mobile`).
- `apps/proxy`: Local LAN HTTP proxy bridging mobile requests to PiecesOS (`@pieces-android/proxy`).
- `apps/pieces-gateway`: Plan B remote gateway running over Tailscale for away-from-home access.
- `packages/allowlist`: Shared route allowlist and path-mapping contract.
- `packages/pieces-api`: Thin HTTP client over PiecesOS read routes.
- `apps/mobile/android/`: Native Android project containing Capacitor plugins (`ShizukuMonitorPlugin`, `AccessibilityPlugin`, `NotificationPlugin`, `SmsPlugin`, `OnDeviceTriagePlugin`, `TextEmbedderPlugin`).

---

## Key Development Commands

- **Run Mobile Unit Tests**:
  ```bash
  cd apps/mobile && npm test
  ```
- **Typecheck & Production Build**:
  ```bash
  cd apps/mobile && npm run build
  ```
- **Linter**:
  ```bash
  npx oxlint
  ```
- **Run Proxy**:
  ```bash
  npm run dev --workspace=@pieces-android/proxy
  ```
- **Run Remote Gateway**:
  ```bash
  npm run dev --workspace=@pieces-android/pieces-gateway
  ```

---

## Code Review Findings & Bug Resolutions (2026-09-10)

During an exhaustive line-by-line codebase review, five bugs and critical runtime edge cases were identified and resolved across the proxy, client queue, and native plugins:

### 1. On-Device Summary Stripping in PiecesOS Assets & Mem0
- **Files**: `apps/proxy/src/seeder.ts`
- **Issue**: When on-device Gemini Nano triaged a background capture, `triageQueue.ts` rewrote `telemetry` to `Package: <pkg>\n\n[on-device summary] <summary> (<category>)`. While `androidTimelineReadable` extracted `[on-device summary]` for Workstream events, `summarizeTelemetry` lacked a marker check. It fell through to `parseKeyValuePairs()`, which matched `Package: <pkg>` and discarded the AI summary, causing seeded PiecesOS Assets and Mem0 to lose the summary.
- **Fix**: Added explicit `ON_DEVICE_SUMMARY_MARKER = "[on-device summary] "` parsing in `summarizeTelemetry` so that `- On-device summary: ${summary}` is preserved in all long-term assets.

### 2. SMS Backfill Queue Deadlock & Clobbering by On-Device Triage
- **Files**: `apps/mobile/src/lib/smsBackfill.ts`, `apps/mobile/src/lib/triageQueue.ts`, `apps/mobile/src/pages/Setup.tsx`
- **Issue**: Historical SMS messages were queued with `type: "system_telemetry"`, `screen: "background"`, and `triaged: undefined`. Because `flushUsageEvents()` stops at the first untriaged background capture, the queue deadlocked. When `triageQueue()` ran, it attempted sequential Gemini Nano inference on up to 5,000 messages (hours of execution) and clobbered the raw SMS records with screen action summaries.
- **Fix**:
  1. Tagged backfilled SMS events with `triaged: false` in `smsBackfill.ts`.
  2. Added defense-in-depth guard in `triageQueue.ts` (`if (event.telemetry?.startsWith("SMS ")) continue;`).
  3. Added immediate `flushUsageEvents()` call after backfill completes in `Setup.tsx`.

### 3. Cursor Pagination Off-By-One Data Loss in SMS Backfill
- **Files**: `apps/mobile/android/app/src/main/java/com/pieces/android/companion/SmsPlugin.java`
- **Issue**: In `SmsPlugin.java`'s cursor loop, `lastScannedDate = date` was updated unconditionally on each row before evaluating `if (kept >= limit)`. On row 201 (the page break), `lastScannedDate` was updated to row 201's timestamp even though row 201 was never added to `messages`. The next query executed `Telephony.Sms.DATE + " > ?"`, permanently skipping row 201.
- **Fix**: Refactored the limit break so `lastScannedDate` only advances across rows actually consumed or intentionally filtered out, with `hasMore = c.moveToNext(); break;` without adopting unread row timestamps.

### 4. `NotificationCaptureService` System Binding Risk
- **Files**: `apps/mobile/android/app/src/main/AndroidManifest.xml`
- **Issue**: `NotificationCaptureService` was declared with `android:exported="false"`. Android requires `NotificationListenerService` implementations to be `android:exported="true"` so the system server can bind across UID boundaries and expose it in Notification Access settings.
- **Fix**: Set `android:exported="true"`. Security is maintained by `android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE"` (signature-level permission).

### 5. SMS Contact Picker React Key Uniqueness
- **Files**: `apps/mobile/src/pages/Setup.tsx`
- **Issue**: Contact rows in the allowlist picker were keyed by `key={c.name}`. Duplicate contact names caused React key collisions.
- **Fix**: Updated key to composite string `key={`${c.name}:${c.numbers.join(",")}`}`.

---

## Core Invariants

1. **Untrusted Content Framing**: All user-generated SMS and third-party notification bodies must be delimited inside `<<<...>>>` blocks in `seeder.ts` to prevent prompt-injection attacks.
2. **Deny-by-Default Routes**: Only routes documented in `docs/ALLOWED_ROUTES.md` may be added to `packages/allowlist`.
3. **Queue Synchronization**: All modifications to `pieces-android:usageQueue` must be wrapped in `withQueueLock()` in `usage.ts` to prevent concurrency races.
4. **Sanitization for Distribution**: Never hardcode user profiles, home directory paths, LAN IPs, bearer tokens, or tailnet addresses in committed files. Use environment variables with safe fallbacks.
