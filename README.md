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

## 2. (Optional) Set up Plan B — remote access via a gateway + Tailscale

Skip this section if LAN-only access is enough for you.

### Why a gateway is necessary

Plan A's proxy (`apps/proxy`) only listens on your home LAN. When your phone is off that
Wi-Fi — on cellular, on another network, anywhere away from home — it has no route to it;
your home router doesn't forward inbound ports here, by design (opening 8787 to the whole
internet would mean the bearer token is the *only* thing standing between the public
internet and PiecesOS).

The gateway (`apps/pieces-gateway`) solves this by being a small relay that sits somewhere
with a real reachable address — a cloud VM, a spare Linux box, anything with a public
IP or a domain pointed at it — and bridges two networks that otherwise can't see each
other:

- **Phone → gateway**: authenticated with its own per-device JWT (issued by `enroll-cli.ts`,
  revocable by `revoke-cli.ts`). This is deliberately a *different* credential from the
  Plan A bearer token, so a leaked/lost phone can be individually revoked without touching
  the home proxy's token at all.
- **Gateway → home proxy**: over Tailscale, addressed by the PC's *tailnet* IP (`100.x.x.x`),
  not its LAN IP — the gateway isn't on your home network, so only the WireGuard tunnel
  Tailscale sets up between the two machines can reach it. This hop reuses the same Plan A
  bearer token as a second auth layer.
- **Fails closed**: if the PC is asleep, logged out, or Tailscale is down, the gateway
  returns an explicit `503` within its timeout window instead of hanging the phone
  indefinitely.

So: no inbound ports opened at home, a revocable identity per phone, and a clean signal
when the home end is unreachable. The three tracks below differ only in *where the gateway
process runs* — the gateway's own code and behavior (`apps/pieces-gateway/src/server.ts`)
is identical in all three.

All three tracks share the same first step:

**Join both machines to the same tailnet.** Install Tailscale on the PC running the Plan A
proxy and on whatever machine will run the gateway, then `tailscale up --authkey=<key>` on
each (generate a reusable auth key at https://login.tailscale.com/admin/settings/keys).
Verify: from the gateway machine, `curl http://<pc-tailnet-ip>:8787/mobile/health` should
return `{"ok":true}` before proceeding — if it doesn't, nothing downstream will work.

---

### Track A — bare Linux host (no Docker)

Any Linux box with a public IP (a cheap VPS, a spare machine, a cloud VM) and Node.js 20+.

1. **Copy the code over** — `apps/pieces-gateway` and `packages/allowlist` (the gateway
   imports the allowlist package by relative path, so keep the same folder layout under
   some root directory on the host):
   ```bash
   rsync -av apps/pieces-gateway packages/allowlist user@host:/opt/pieces-android/apps-and-packages-parent/
   ```

2. **Install and build** on the host:
   ```bash
   cd /opt/pieces-android/.../pieces-gateway
   npm install
   ```

3. **Write the environment file** (`apps/pieces-gateway/.env` — never commit this):
   ```
   GATEWAY_JWT_SECRET=<generate with: openssl rand -base64 32>
   HOME_PROXY_BASE_URL=http://<pc-tailnet-ip>:8787
   HOME_PROXY_TOKEN=<the same token from apps/proxy/.bearer-token>
   GATEWAY_PORT=8788
   ```

4. **Run it as a systemd service** so it survives reboots/crashes, e.g.
   `/etc/systemd/system/pieces-gateway.service`:
   ```ini
   [Unit]
   Description=Pieces Android Gateway
   After=network-online.target tailscaled.service

   [Service]
   EnvironmentFile=/opt/pieces-android/.../pieces-gateway/apps/pieces-gateway/.env
   WorkingDirectory=/opt/pieces-android/.../pieces-gateway/apps/pieces-gateway
   ExecStart=/usr/bin/npx tsx src/server.ts
   Restart=on-failure
   User=piecesgw

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now pieces-gateway
   ```

5. **Expose it.** The gateway listens on `0.0.0.0:8788` unencrypted — don't point a public
   IP straight at that port. Either put it behind a reverse proxy for TLS (see Track C
   below, it applies here too), or if you only need access over the tailnet itself (no
   public domain at all), skip the reverse proxy entirely and give the phone
   `http://<gateway-tailnet-ip>:8788` directly — only requires the phone to also be on
   your tailnet (e.g. via the Tailscale Android app), trading "works from anywhere" for
   "no public exposure at all."

6. **Enroll a device**:
   ```bash
   cd apps/pieces-gateway && npm run enroll -- "My Phone"
   ```
   Prints a device token for the phone's Setup screen. Revoke later with
   `npm run revoke -- <deviceId>` (find the ID with `npm run list-devices`).

---

### Track B — Windows PC (same machine as Plan A, or a second one)

Same idea as Track A, running on Windows instead — useful if you'd rather not stand up a
separate Linux box, or want to test the gateway alongside the Plan A proxy first.

1. Ensure Node.js 20+ and Tailscale are installed on the PC.
2. From the repo root:
   ```powershell
   cd apps\pieces-gateway
   npm install
   ```
3. Create `apps\pieces-gateway\.env` with the same four variables as Track A step 3.
4. **Register it as a Windows Scheduled Task**, the same pattern used for the Plan A proxy
   (`apps/proxy/scripts/register-service.ps1`) — adapt that script's `ExecStart` equivalent
   to run `npx tsx src\server.ts` from `apps\pieces-gateway`, S4U mode so it starts at boot
   without a stored password. There's no ready-made `register-service.ps1` for the gateway
   yet; copy and edit the proxy's script, pointing it at the gateway's folder and
   `GATEWAY_PORT` (8788) instead.
5. **Windows Firewall**: allow inbound TCP 8788 the same way `apps/proxy/scripts/windows-firewall-rule.ps1`
   does for 8787 — adjust the port, and scope it to whatever profile matches how you're
   exposing it (Private only if reachable solely over the tailnet; see the exposure note
   in Track A step 5, it applies here unchanged).
6. **Enroll a device**: `npm run enroll -- "My Phone"` from `apps\pieces-gateway`.

Running the gateway on the same PC as the Plan A proxy is fine — `HOME_PROXY_BASE_URL` can
even point at `http://127.0.0.1:8787` in that case instead of the tailnet IP, since they're
on the same machine. You'd still want it reachable from outside (via Track C's reverse
proxy, or Tailscale on your phone) — the tailnet hop is what lets it stay off the open
internet either way.

---

### Track C — put a webserver (reverse proxy) in front

Neither Track A nor B terminates TLS or gives you a real hostname on their own — the
gateway just speaks plain HTTP on its own port. This track adds that layer, and works on
top of either Track A or Track B without changing anything about the gateway itself.

**Using Caddy** (automatic HTTPS via Let's Encrypt, minimal config):

1. **Add a DNS A record** for whatever subdomain you want (e.g. `pieces.yourdomain.com`)
   pointing at the host's public IP.
2. **Caddyfile block:**
   ```
   pieces.yourdomain.com {
       reverse_proxy localhost:8788
   }
   ```
   (or `pieces-gateway:8788` if Caddy and the gateway are both Docker containers on the
   same compose network — see `apps/pieces-gateway/deploy/docker-compose.snippet.yml` and
   `apps/pieces-gateway/Dockerfile` for that variant, which is how this was originally
   deployed against an existing Caddy+Docker host.)
3. **Reload Caddy** (`caddy reload` on bare metal, or `docker compose restart caddy` in the
   Docker variant) and watch its logs for `certificate obtained successfully` for the new
   hostname.

**Using nginx**, the equivalent is a `server` block with
`proxy_pass http://127.0.0.1:8788;` plus `certbot --nginx` for TLS — omitted here since
Caddy's automatic-HTTPS default needs far less config for this single-route case.

Once TLS is in front, the phone's Setup screen gets `https://pieces.yourdomain.com` as the
server address, paired with whichever device token Track A/B's `enroll-cli` printed.

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
