import { Preferences } from "@capacitor/preferences";
import { getConnectionTargets } from "./config";

export class ProxyNotConfiguredError extends Error {
  constructor() {
    super("Proxy is not configured — complete Setup first.");
    this.name = "ProxyNotConfiguredError";
  }
}

// Both the LAN proxy and the remote gateway return 503 specifically when the
// home node (PC running PiecesOS) is unreachable within their timeout — a
// deliberate fail-closed design, not a generic server error. Surfacing it
// distinctly lets the UI say "PC is offline" instead of a raw error string.
export class HomeNodeUnreachableError extends Error {
  constructor(detail?: string) {
    super(detail ?? "The home PC is offline or unreachable right now.");
    this.name = "HomeNodeUnreachableError";
  }
}

// The proxy/gateway enforce their own 5s upstream timeout and return 503 when
// PiecesOS is unreachable — but that only helps once our request actually
// reaches them. A stalled TCP handshake or dropped packet on the phone's own
// network never gets a response at all, so fetch() hangs indefinitely with
// no client-side abort. This client-side timeout ensures every call fails
// closed instead of leaving the UI stuck on "Checking…" forever.
const CLIENT_FETCH_TIMEOUT_MS = 10000;
// /mobile/recent/assets proxies to PiecesOS's /assets, which the proxy itself
// allows up to 30s for (a real store scan on a non-trivial asset count is
// legitimately slow — see ASSETS_TIMEOUT_MS in apps/proxy/src/server.ts).
// The client timeout must exceed that, or it aborts requests the server was
// still on track to complete successfully.
const ASSETS_CLIENT_FETCH_TIMEOUT_MS = 35000;
// /mobile/ask falls back to a local Ollama call (grounded in Pieces data)
// when PiecesOS itself can't answer — CPU-bound local generation measured
// 23.8s-63.9s in testing against OLLAMA_TIMEOUT_MS=90000 in
// apps/proxy/src/ollama-fallback.ts. Must exceed that ceiling or the client
// aborts requests the server was still on track to complete.
const ASK_CLIENT_FETCH_TIMEOUT_MS = 100000;
// /mobile/summaries makes one /workstream_summary/{id} call plus up to a few
// parallel /annotation/{id} calls PER summary (see apps/proxy/src/summaries.ts) —
// measured 0.4s for 21 summaries against the local PiecesOS install, but that's
// with an unusually low PIECES_BASE_URL round-trip; give real headroom for a
// slower network path rather than assume the default 10s always covers it.
const SUMMARIES_CLIENT_FETCH_TIMEOUT_MS = 30000;

// Plan A (LAN) -> Plan B (remote gateway) failover, merged from shizuku-monitor.
// Tries each configured target in order. A target is abandoned and the next
// one tried on: connection error / timeout, 401 or 403 (stale token for that
// profile — the OTHER profile may still be valid), or any 5xx. A 503 from the
// LAST target surfaces as HomeNodeUnreachableError; a non-auth 4xx (e.g. 404,
// 400) is returned as-is since retrying a different host won't help.
async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const targets = await getConnectionTargets();
  if (targets.length === 0) throw new ProxyNotConfiguredError();

  const baseTimeout = path.startsWith("/mobile/recent/assets")
    ? ASSETS_CLIENT_FETCH_TIMEOUT_MS
    : path.startsWith("/mobile/ask")
      ? ASK_CLIENT_FETCH_TIMEOUT_MS
      : path.startsWith("/mobile/summaries")
        ? SUMMARIES_CLIENT_FETCH_TIMEOUT_MS
        : CLIENT_FETCH_TIMEOUT_MS;

  let lastError: unknown = new HomeNodeUnreachableError();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const isLast = i === targets.length - 1;
    // Probe the LAN target fast when a remote fallback exists, so being away
    // from home doesn't cost the full timeout before failing over. Not on
    // /mobile/ask — its long timeout is the whole point of that route.
    const probe =
      targets.length > 1 && i === 0 && target.mode === "lan" && !path.startsWith("/mobile/ask");
    const timeoutMs = probe ? 2500 : baseTimeout;

    let res: Response;
    try {
      res = await fetch(`${target.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${target.token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError =
        err instanceof Error && err.name === "TimeoutError"
          ? new HomeNodeUnreachableError("Request timed out reaching the proxy.")
          : err;
      continue; // network error / timeout -> try next target
    }

    if (res.status === 401 || res.status === 403) {
      lastError = new Error(`Auth rejected by ${target.mode} target: HTTP ${res.status}`);
      if (!isLast) continue;
      return res; // last target: let the caller see the 401
    }
    if (res.status === 503) {
      const body = await res.json().catch(() => null);
      lastError = new HomeNodeUnreachableError(body?.reason ?? body?.error);
      if (!isLast) continue;
      throw lastError;
    }
    if (res.status >= 500) {
      lastError = new Error(`${target.mode} target error: HTTP ${res.status}`);
      if (!isLast) continue;
      return res;
    }

    return res; // ok, or a non-auth 4xx that failover can't fix
  }

  throw lastError;
}

export type AskResult =
  | { status: "answered"; answers: unknown }
  | { status: "unavailable"; reason: string; likelyNoModelConfigured?: boolean };

// One retry, after a short delay, specifically for HomeNodeUnreachableError.
// Real, reproducible cause: right after the gateway process restarts,
// Tailscale needs to re-establish its direct path to the home PC - the
// FIRST request in that window can take the full upstream timeout and fail,
// while every request after it is fast (sub-second in testing, 2026-08-29).
// A startup warm-up ping on the gateway itself covers most of this, but a
// client-side retry is the backstop for whatever window it doesn't catch
// (e.g. the phone's own request racing the warm-up). Retries only ONE time
// and only for this specific error - a real "PC is off" case still surfaces
// normally after the retry also fails, rather than hanging or looping.
//
// Deliberately NOT applied to ask() - its own client timeout is already
// 100s (ASK_CLIENT_FETCH_TIMEOUT_MS, covering the Ollama fallback path), so
// stacking a full retry on top would make the worst case ~205s before the
// user sees anything. A slow-but-generous single attempt beats doubling an
// already-long wait; the user's own Retry button covers the rare case where
// Ask specifically hits the restart window. Applied only to the fast routes
// (status ~10s, summaries ~30s) where a second attempt stays reasonable.
const HOME_UNREACHABLE_RETRY_DELAY_MS = 5000;
async function withHomeUnreachableRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HomeNodeUnreachableError)) throw err;
    await new Promise((resolve) => setTimeout(resolve, HOME_UNREACHABLE_RETRY_DELAY_MS));
    return await fn();
  }
}

// Lightweight "last known good" cache for screens where stale-but-real data
// beats a blank error screen during a transient home-offline blip (e.g. the
// PC briefly asleep, a router hiccup). Never used to mask errors — callers
// still see the fresh call's outcome; this only supplies a fallback value
// alongside it. Preferences (not localStorage/memory) so it survives an app
// restart, not just a screen navigation.
const CACHE_KEY_PREFIX = "pieces-android:cache:";

async function readCache<T>(key: string): Promise<{ value: T; at: string } | null> {
  try {
    const { value } = await Preferences.get({ key: CACHE_KEY_PREFIX + key });
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

async function writeCache<T>(key: string, value: T): Promise<void> {
  try {
    await Preferences.set({
      key: CACHE_KEY_PREFIX + key,
      value: JSON.stringify({ value, at: new Date().toISOString() }),
    });
  } catch {
    // Best-effort - a failed cache write should never break the real call.
  }
}

/** Unauthenticated liveness check — safe to call before Setup is complete. */
export async function checkProxyHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/mobile/health`, {
      signal: AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

export interface StatusResult {
  health: string;
  version: string;
}

async function getStatusUncached(): Promise<StatusResult> {
  const [healthRes, versionRes] = await Promise.all([
    authedFetch("/mobile/status/health"),
    authedFetch("/mobile/status/version"),
  ]);
  if (!healthRes.ok) throw new Error(`Status health check failed: HTTP ${healthRes.status}`);
  if (!versionRes.ok) throw new Error(`Status version check failed: HTTP ${versionRes.status}`);
  return { health: await healthRes.text(), version: await versionRes.text() };
}

/**
 * The real end-to-end check: this round-trips through proxy/gateway all the
 * way to PiecesOS and back, unlike checkProxyHealth (which only proves the
 * gateway process itself answers). Setup's "Connected" and Status's own
 * display both use this - a gateway that's up but can't reach PiecesOS is
 * NOT "connected" from the user's point of view, even though the earlier
 * unauthenticated health check would say otherwise.
 */
export async function getStatus(): Promise<StatusResult> {
  const result = await withHomeUnreachableRetry(getStatusUncached);
  await writeCache("status", result);
  return result;
}

/** Last successful getStatus() result, if any - for a stale-data fallback display. */
export async function getCachedStatus(): Promise<{ value: StatusResult; at: string } | null> {
  return readCache<StatusResult>("status");
}

export interface WorkstreamSummary {
  id: string;
  name: string;
  created: string;
  text: string;
}

/**
 * "What got done" — PiecesOS's own AI-generated workstream rollups, not raw
 * captured telemetry. The proxy filters each summary down to its SUMMARY (or
 * DESCRIPTION) annotation only; the broader HIERARCHICAL_PROFILE_SUMMARY
 * annotation every summary also carries never reaches this client.
 */
async function getWorkstreamSummariesUncached(): Promise<WorkstreamSummary[]> {
  const res = await authedFetch("/mobile/summaries");
  if (!res.ok) throw new Error(`Summaries fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.summaries) ? body.summaries : [];
}

export async function getWorkstreamSummaries(): Promise<WorkstreamSummary[]> {
  const result = await withHomeUnreachableRetry(getWorkstreamSummariesUncached);
  await writeCache("summaries", result);
  return result;
}

/** Last successful getWorkstreamSummaries() result, if any - for a stale-data fallback display. */
export async function getCachedWorkstreamSummaries(): Promise<{ value: WorkstreamSummary[]; at: string } | null> {
  return readCache<WorkstreamSummary[]>("summaries");
}

export async function ask(query: string): Promise<AskResult> {
  const res = await authedFetch("/mobile/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Ask failed: HTTP ${res.status}`);
  return res.json();
}
