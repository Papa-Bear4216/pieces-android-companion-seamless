# Pieces-Android Companion - Seamless

Native Android companion for PiecesOS — Obsidian Glass UI, on-device Gemini Nano triage, zero-setup native Accessibility & Notification capture, and robust dual-path networking (Plan A LAN + Plan B remote gateway).

- **100% Shizuku-Free & Seamless**: Runs purely through standard Android Accessibility and Notification Listener permissions. No wireless debugging pairing, no ADB scripts, and no background daemon crashes to manage.
- **Dual-Path Zero-Loss Connection**:
  - **Plan A (LAN)**: Blazing fast local proxy on your home Wi-Fi (`http://<lan-ip>:8787`).
  - **Plan B (Remote)**: Automatic seamless failover through Tailscale gateway when on cellular or outside networks (`https://pieces.<domain>`).
- **On-Device Local Intelligence**: Integrates with on-device Gemini Nano / AICore and on-device semantic embeddings for offline search, intelligent triage, and privacy-preserving context indexing.
- **Durable Offline Outbox**: Capture events and screen context queue persistently in local Room SQLite storage and sync seamlessly the moment a connection to PiecesOS is available.

## No data lost if the connection drops

Every telemetry event survives a broken link, at both hops:

- **Phone → proxy**: events queue in Capacitor Preferences (`apps/mobile/src/lib/usage.ts`)
  and only clear on a confirmed successful send. Any failure — offline, proxy down, home PC
  unreachable — leaves them queued for the next retry (on every screen navigation, plus a
  5-minute backstop timer).
- **Proxy → PiecesOS**: every event is written to a permanent, unconditional audit log
  (`USAGE_LOG_PATH`) the moment it's received, regardless of what happens next. If seeding
  it into PiecesOS fails (e.g. PiecesOS is restarting), it also goes into a separate durable
  retry queue (`SEED_QUEUE_PATH`, default `~/.claude/pieces-seed-queue.jsonl`) that a
  background loop drains every 30 seconds — on both a timer and proxy startup — until it
  succeeds or hits 50 attempts (~25 minutes), at which point it's dropped from the retry
  queue but remains in the permanent audit log either way.

### Passive mode (advanced, requires a second explicit confirmation)

By default, screen-text capture only happens when you tap "Scan Screen Text" — a single
on-demand snapshot. There's a separate, further-gated **passive mode** that instead pushes
captured text automatically, continuously, while an allowed app is in the foreground:

- Debounced: waits ~2 seconds after the screen stops changing before considering a push, so
  it doesn't fire on every keystroke/scroll.
- Deduped: skips the push if the text is identical to the last thing actually sent.
- Still scoped to the same per-app allowlist as manual capture — nothing outside apps you've
  explicitly selected.

Because this is meaningfully more invasive than a button press — it runs in the background,
repeatedly, without asking each time — enabling it requires typing a confirmation phrase in
the Status tab, on top of the toolkit opt-in and having at least one app allowlisted. It can
be turned off at any time from the same screen, and clearing the allowlist to zero apps
turns it off automatically.

```
apps/proxy/          Node HTTP proxy (Plan A) — bearer auth + deny-by-default allowlist in front of PiecesOS
apps/pieces-gateway/ Node HTTP gateway (Plan B) — JWT device auth + revoke, forwards to apps/proxy over Tailscale
apps/mobile/         Capacitor Android app (Setup / Status / Ask / Recent) — same UI works with either backend
packages/pieces-api/ Typed client for the handful of PiecesOS routes the proxy calls
packages/allowlist/  Shared deny-by-default route list — imported by BOTH apps/proxy and apps/pieces-gateway
docs/                ALLOWED_ROUTES.md (evidence log), ACCEPTANCE.md (test run record)
```

## 1. Run the proxy (on the PC running PiecesOS)

```bash
cd apps/proxy
npm install

# generate a bearer token once, save it somewhere safe
node scripts/generate-token.mjs

# start the proxy
PROXY_BEARER_TOKEN=<paste-token-here> npm start
```

By default it listens on `0.0.0.0:8787` and proxies to PiecesOS at
`http://127.0.0.1:39300`. Override either with env vars if needed:

```bash
PROXY_PORT=8787 PIECES_BASE_URL=http://127.0.0.1:39300 PROXY_BEARER_TOKEN=... npm start
```

**Before exposing this on your LAN**, restrict the port to your Private network profile —
run `apps/proxy/scripts/windows-firewall-rule.ps1` in an elevated PowerShell window. This
is a manual step by design; it is not run automatically by `npm start`.

To keep it running continuously (needed for Plan B, since the gateway depends on this
proxy being reachable at any time), register it as a Windows Scheduled Task instead of
running it manually — see `apps/proxy/scripts/register-service.ps1`. It defaults to S4U
mode (runs at boot and logon, no stored password required — appropriate if your Windows
account is passwordless). Run it once, elevated:

```powershell
powershell.exe -ExecutionPolicy Bypass -File "apps\proxy\scripts\register-service.ps1"
```

Find your PC's LAN IP (`ipconfig`, look for the IPv4 address on your home network
adapter) — the phone will need `http://<that-ip>:8787` for Plan A (LAN) mode.

## 2. (Optional) Set up Plan B — remote access via a remote host + Tailscale

Skip this section if LAN-only access is enough for you.

Requirements: a Tailscale account (free tier is fine), and a Linux host reachable from the
internet with Docker + Caddy already fronting at least one domain (this was built against
an existing GCE VM that already ran Caddy for another service — adapt paths if yours
differs).

1. **Join both machines to the same tailnet.** Install Tailscale on the PC running the
   Plan A proxy and on your remote host, then `tailscale up --authkey=<key>` on each
   (generate a reusable auth key at https://login.tailscale.com/admin/settings/keys).
   Verify: from the remote host, `curl http://<pc-tailnet-ip>:8787/mobile/health` should
   return `{"ok":true}` before proceeding — if it doesn't, nothing downstream will work.

2. **Copy `apps/pieces-gateway` and `packages/allowlist`** to the remote host (matching
   relative layout matters — the Dockerfile expects to be built with the repo root as
   context, see the comment at the top of `apps/pieces-gateway/Dockerfile`).

3. **Add a new service to your existing docker-compose.yml**, alongside whatever Caddy
   already fronts — see `apps/pieces-gateway/deploy/docker-compose.snippet.yml` for the
   exact block. Add `pieces-gateway` to Caddy's `depends_on` list too.

4. **Write a `.env` file** at `apps/pieces-gateway/.env` on the remote host (never commit
   this):
   ```
   GATEWAY_JWT_SECRET=<generate with: openssl rand -base64 32>
   HOME_PROXY_BASE_URL=http://<pc-tailnet-ip>:8787
   HOME_PROXY_TOKEN=<the same token from apps/proxy/.bearer-token>
   GATEWAY_PORT=8788
   ```

5. **Add a DNS A record** for whatever subdomain you want (e.g. `pieces.yourdomain.com`)
   pointing at the remote host's public IP, and a matching block in your Caddyfile:
   ```
   pieces.yourdomain.com {
       reverse_proxy pieces-gateway:8788
   }
   ```

6. **Build and start it**: `docker compose up -d --build pieces-gateway`, then
   `docker compose restart caddy` to pick up the new Caddyfile block. Watch
   `docker logs <caddy-container>` for `certificate obtained successfully` for your new
   hostname.

7. **Enroll a device**:
   ```bash
   docker exec --env-file apps/pieces-gateway/.env <gateway-container> npx tsx src/enroll-cli.ts "My Phone"
   ```
   This prints a device token — that's what goes in the phone's Setup screen alongside
   `https://pieces.yourdomain.com`.

To revoke a device later: `docker exec --env-file apps/pieces-gateway/.env <gateway-container> npx tsx src/revoke-cli.ts <deviceId>` (find the ID with `list-devices`).

## 3. Install the APK on your phone

A debug build already exists at
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` after running:

```bash
cd apps/mobile
npm install
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Sideload `app-debug.apk` onto your phone (enable "Install unknown apps" for whatever
transfer method you use — ADB, a file share, email to yourself, etc.).

## 4. Connect the app

Open the app → **Setup** tab. Same two fields either way — just different values:

**Plan A (on your home Wi-Fi):**
1. Server address: `http://<pc-lan-ip>:8787`
2. Token: the value from `apps/proxy/.bearer-token` on the PC

**Plan B (away from home, if you set it up):**
1. Server address: `https://pieces.yourdomain.com`
2. Token: the device token printed by `enroll-cli.ts`

Either way, tap **Test & Save** — it calls the server's unauthenticated `/mobile/health`
first to confirm reachability, then saves both values via Capacitor's native Preferences
storage. Once saved, **Status**, **Ask**, and **Recent** all use the saved address + token
automatically — switch between Plan A and Plan B any time by just changing Setup.

## Optional: Mem0 integration

If you set `MEM0_API_KEY` in the proxy's environment, Ask queries and captured telemetry
are also mirrored to your [Mem0](https://mem0.ai) account (`MEM0_USER_ID`, default
`pieces-android-user`). Entirely optional — leave both unset and this is skipped silently,
no error, no dependency on having a Mem0 account.

## Known limitations

- **Ask requires a model configured in PiecesOS.** If PiecesOS's answer-generation endpoints
  (`/qgpt/relevance` with a search scope, `/qgpt/question`) return HTTP 500, the app shows
  in-app guidance pointing at PiecesOS's Settings → Models/Copilot screen — this is a
  PiecesOS-side setup step, not a bug in the proxy or app. See `docs/ALLOWED_ROUTES.md` for
  the underlying evidence. Status and Recent don't depend on a model and work regardless.
- **Plan A proxy uptime** depends on staying logged into Windows — it's registered to run
  at boot and logon (no stored password, by design), but has not yet been proven to
  survive a fully unattended reboot with nobody signing back in. See `docs/ACCEPTANCE.md`
  for the exact gap and how to test it.
- **Plan B has not been tested from an actual phone on cellular/off-LAN network** — every
  Plan B behavior documented in `docs/ACCEPTANCE.md` was verified via `curl`, not from the
  installed APK itself.
