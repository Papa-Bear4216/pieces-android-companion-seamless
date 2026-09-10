# hermes-host — infrastructure audit

**Date:** 2026-09-10
**Host:** `hermes-host` (Tailscale `100.64.0.1`, GCP internal `10.0.0.2`, public `198.51.100.1` / seen via ACME as `198.51.100.x` = Tailscale funnel/relay egress)
**Trigger:** post token-rotation, asked to audit the space and evaluate the hardware
**Method:** read-only SSH (`lscpu`, `free`, `df`, `docker ...`, `ss`, `ps`, `systemctl`, GCP metadata). Nothing modified.

---

## Verdict

The box is **healthy for its current load and has comfortable headroom** — CPU ~0.5%, RAM 20% used, disk 41%. Nothing is on fire. But there are **five real issues**, none of which affect the pieces-gateway path you just fixed:

| # | Severity | Issue |
|---|----------|-------|
| 1 | Medium | Pending kernel/libc reboot outstanding since Sep 5 (host up 46 days) |
| 2 | Medium | Caddy has been failing ACME for 3 domains for **30 days straight** (142 attempts) + a cert-cache write bug |
| 3 | Low-Med | `docker-compose.yml` on disk drifted from the repo snippet (`network_mode: host`, no `expose`) |
| 4 | Low | 2 zombie `git` processes parented to a live PID since Aug 11 |
| 5 | Low | 5.4 GB of reclaimable Docker build cache; 32 apt updates pending |

---

## Hardware

| | |
|---|---|
| Instance type | **GCP `e2-medium`** (shared-core, 2 vCPU burst, 4 GB) |
| Zone | `us-east1-b` |
| CPU platform | Intel Broadwell — `Xeon @ 2.20 GHz`, 1 socket / 1 core / 2 threads |
| RAM | 3.8 GiB total · **772 MiB used** · 2.3 GiB free · 1.0 GiB buff/cache |
| Swap | 2.0 GiB · 123 MiB used (light, fine) |
| Disk | `/dev/root` 48 GB · **20 GB used (41%)** · 29 GB free — single filesystem, Docker shares it |
| Kernel | `6.17.0-1021-gcp` (a newer `-1022` and a `7.0.0` are staged for next boot) |
| OS | Ubuntu 24.04.4 LTS |
| Uptime | **46 days**, load avg `0.16 / 0.12 / 0.05` (≈8% of one thread) |

**Assessment:** `e2-medium` is right-sized for this workload. Steady-state RAM is 772 MiB against 3.8 GiB; the three containers together use ~185 MiB. An `e2-small` (2 GB) would also fit today but leaves no margin for the `pieces-gateway` Node process under load (it briefly touched 141 MiB idle, and tsx compiles spike higher) plus the two `bear` Node apps. **No resize needed. No upgrade needed.** If cost matters, `e2-small` is defensible but risky; staying on `e2-medium` is the safe call.

**Burst-credit note:** e2 shared-core instances earn/spend CPU credits. Load is so low (0.16) that credits are always full — not a concern now, but if any workload here ever goes CPU-heavy, this instance will throttle to the ~0.5 vCPU baseline.

---

## What's running

### Containers (`hermes-bridge` compose project)

| Container | Image | Up | CPU | Mem | Restarts | OOM |
|-----------|-------|-----|-----|-----|----------|-----|
| `hermes-bridge-pieces-gateway-1` | `hermes-bridge-pieces-gateway` | 3 min (just recreated) | 0.18% | 141 MiB | 0 | no |
| `hermes-bridge-hermes-bridge-1` | `hermes-bridge-hermes-bridge` | 4 weeks | 0.00% | 25 MiB | 0 | no |
| `hermes-bridge-caddy-1` | `caddy:2` | 4 weeks | 0.00% | 19 MiB | 0 | no |

All three: `restart: unless-stopped`, no healthchecks defined, zero restarts, no OOM kills. Stable.

### Host-level services (not in Docker)

- **`tailscaled`** 1.102.2 — up, `hermes-host` online, direct connection to client device at `198.51.100.1:41641`. This is the path the gateway uses to reach the Plan A proxy.
- **A second Node app on `:3000`** — `node /home/<user>/api-server/dist/index.js`, run under **PM2** (`God Daemon`, PM2 v7.0.1), user `<user>`, up since Aug 13, 91 min CPU. Caddy proxies `api.example.com` → `host.docker.internal:3000` to it. This is an auxiliary backend — unrelated to pieces, but sharing the box.
- `dockerd` 29.7.2, `sshd`, `systemd-resolved`, `snapd`.

### Listening ports

| Port | Bound | Process | Exposure |
|------|-------|---------|----------|
| 22 | `0.0.0.0` + `[::]` | sshd | GCP firewall-gated |
| 80, 443 | `0.0.0.0` + `[::]` | docker-proxy → caddy | public |
| **8788** | **`0.0.0.0`** | node (pieces-gateway) | **see issue 3** |
| 3000 | `0.0.0.0` | node (api, PM2) | via Caddy only, but bound wide |
| 46496 | `100.64.0.1` | tailscaled | tailnet |
| 53 | `127.0.0.53/54` | systemd-resolved | local |

---

## Issues in detail

### 1. Pending reboot since Sep 5 — Medium

`/var/run/reboot-required` present since Sep 5 06:45. Packages: `libc6`, `linux-image-6.17.0-1022-gcp`, `linux-base`, `apparmor`, `linux-image-7.0.0-1011-gcp`. `unattended-upgrades` is active and installed these but (correctly) won't reboot on its own.

Host has been up 46 days. Running kernel `6.17.0-1021` has a known successor staged. The `libc6` update in particular means **every long-running process is using an unpatched libc**.

**Recommendation:** schedule a reboot. All three containers are `restart: unless-stopped` and the auxiliary API is under PM2 (also auto-restarts), so a reboot should self-heal — but verify the PM2 resurrect list is saved (`pm2 save` was run) and that `pieces-gateway`'s tsx build still works after the newer kernel. Do it during a window when a few minutes of Plan B downtime is acceptable. ~3-5 min of downtime.

### 2. Caddy ACME failing for 30 days — Medium

Caddy has tried **142 times over 30 days** (`elapsed: 2592366s`, `max_duration: 2592000s` = its 30-day ceiling) to get certs for:

- `example.com` (apex)
- `api.example.com`
- `app.example.com`

Every attempt fails HTTP-01 with `404` on the ACME challenge path, then a **second bug**: `caching certificate after obtaining it: open /data/caddy/certificates/.../[domain].key: no such file or directory`.

Two distinct problems:

1. **Challenge 404s** — the ACME validator (`198.51.100.x`) hits `http://<domain>/.well-known/acme-challenge/...` and gets 404. For `app.example.com` this is expected and **should be removed from the Caddyfile** — that hostname is served elsewhere, not this box; Caddy will never validate it. For the two `example.com` names, either DNS for those isn't pointing at this host's public IP, or inbound :80 isn't reaching Caddy from the validator's path (the `198.51.100.x` source suggests traffic is arriving via a relay, not direct — if :80 isn't exposed the HTTP-01 challenge can't complete).
2. **Cert-cache write failure** — even a *successful* obtain would fail to persist because the `.key` file path doesn't exist. Suggests `caddy_data` volume permissions or a partial/corrupted `/data/caddy/certificates` tree. Worth an `ls -la` inside the volume.

**Impact:** `pieces.example.com` is **not** in the failing list — so the Plan B pieces path has a valid cert and works. This is degrading the auxiliary domains, not pieces. Still, 142 failed ACME jobs is log noise and a latent risk if the working certs ever need renewal through the same broken cache path.

**Recommendation:** (a) drop `app.example.com` from the Caddyfile entirely; (b) check DNS A records for `example.com` + `api.` and whether :80 is publicly reachable; (c) inspect the `caddy_data` volume's `certificates/` tree for the permission/path problem.

### 3. Compose drift: `pieces-gateway` uses `network_mode: host` — Low-Medium

The **repo snippet** (`apps/pieces-gateway/deploy/docker-compose.snippet.yml`) specifies:
```yaml
    env_file: ../pieces-android/apps/pieces-gateway/.env
    volumes: [pieces_gateway_data:/data]
    expose: ["8788"]
```
The **live file** on the host has instead:
```yaml
    network_mode: host
    volumes: [pieces_gateway_data:/data]
    # no expose
```

Consequences of `network_mode: host`:
- The gateway's Node process binds **`0.0.0.0:8788` on the host directly** (confirmed in `ss` output — `pid=3052111` on `0.0.0.0:8788`), not on the compose bridge network.
- GCP's firewall is what keeps :8788 from the public internet — there's no Docker network isolation in front of it anymore. If a firewall rule were ever loosened, the gateway would be directly exposed.
- Caddy reaches it via `host.docker.internal:8788` (see Caddyfile), which only works because of the `extra_hosts: host-gateway` mapping on the caddy service. This is more fragile than the repo's compose-network design (`reverse_proxy pieces-gateway:8788`).
- It also means the gateway shares the host network namespace with the `bear` API on :3000 and everything else.

Likely done to simplify the gateway→Tailscale-proxy call (host networking = the container sees the host's tailscale0 interface directly). But it trades away isolation.

**Recommendation:** document why host networking was chosen, or revert to the repo's bridge-network design. At minimum, update the repo snippet to match reality so the next person deploying doesn't get a different topology. Confirm the GCP firewall explicitly denies inbound :8788 (and :3000).

### 4. Two zombie `git` processes — Low

```
root 1114334 Z git <defunct>  (since Aug 11, parent PID 1113545)
root 1114338 Z git <defunct>  (since Aug 11, parent PID 1113545)
```

Parent `1113545` is still alive and never reaped these children. Harmless (zombies hold only a PID slot, no memory), but they've been there a month and indicate some tool/script that shells out to `git` and doesn't `wait()`. If PID 1113545 is a long-running agent/daemon, worth identifying (`ps -p 1113545 -o pid,ppid,cmd`). They'll clear on the next reboot regardless.

### 5. Housekeeping — Low

- **Docker build cache: 5.4 GB, 838 MB reclaimable** (`docker system df` shows 60 cache entries, 0 active). `docker builder prune` would recover it. Not urgent at 41% disk.
- **Images: 5.07 GB, 386 MB reclaimable** — one dangling layer set.
- **32 apt updates pending** beyond the security ones already applied. `unattended-upgrades` handles security; the rest need a manual `apt upgrade` + the reboot from issue 1.

---

## What is NOT a problem

- **pieces-gateway** — recreated 3 min ago with the rotated token, `[warmup] home proxy reachable (attempt 1, HTTP 200)`, 0 restarts, 141 MiB, healthy.
- **Memory pressure** — none. 2.3 GiB free, swap barely touched.
- **Disk pressure** — none. 29 GB free.
- **CPU** — effectively idle.
- **systemd** — 0 failed units.
- **Tailscale** — connected, direct path to client device.
- **The pieces.example.com cert** — valid (not in the ACME failure list).

---

## Recommended actions, in order

1. **Remove `app.example.com` from the Caddyfile** — 2 min, stops a chunk of the ACME failure loop immediately.
2. **Reboot the host** during a maintenance window — clears the pending kernel/libc updates, the zombies, and picks up 46 days of drift. Verify containers + PM2 come back.
3. **Investigate the remaining ACME failures** — DNS A records for `example.com` + `api.`, inbound :80 reachability, and the `caddy_data` cert-cache path/permission bug.
4. **Reconcile the compose file** — either document the `network_mode: host` decision in the repo or revert to the bridge design; update the snippet either way. Verify GCP firewall denies :8788 and :3000.
5. **`docker builder prune`** — recover 5.4 GB when convenient.
6. **Identify PID 1113545** — the process leaking git zombies.

None of these are urgent. #1 and #2 are the ones worth doing this week.
