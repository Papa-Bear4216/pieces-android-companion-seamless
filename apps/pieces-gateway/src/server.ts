import { createServer } from "node:http";
import { Agent, setGlobalDispatcher } from "undici";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { verifyToken } from "./jwt.js";

// Observed in practice: a pooled keep-alive socket to the home proxy over
// Tailscale gets silently dropped (NAT/WireGuard idle timeout) without
// either side sending a FIN/RST. undici's default keep-alive behavior then
// tries to reuse that dead socket on the next fetch(), gets no response,
// and burns the full UPSTREAM_TIMEOUT_MS before failing - even though a
// FRESH connection to the exact same address succeeds in well under a
// second. This produced an intermittent 200/200/503 pattern that looked
// like a flaky tunnel but was actually a stale-socket-reuse bug. A short
// keepAliveTimeout forces undici to open a new socket well before Tailscale
// has a chance to drop the old one silently underneath it.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000 }));

const PORT = Number(process.env.GATEWAY_PORT ?? 8788);
// Home PC's Tailscale IP, not its LAN IP - this gateway runs on a remote host
// off the home network entirely, and only the tailnet bridges the two.
const HOME_PROXY_BASE_URL = process.env.HOME_PROXY_BASE_URL;
// The Plan A proxy's own bearer token - this is a SECOND auth layer, distinct
// from the JWT below. Phone -> gateway is JWT; gateway -> home proxy is still
// the original Plan A bearer token. Never commit this value; it lives in the
// remote host's compose env only.
const HOME_PROXY_TOKEN = process.env.HOME_PROXY_TOKEN;
const JWT_SECRET = process.env.GATEWAY_JWT_SECRET;
// Default for routes with no documented worst case of their own. Several
// routes need MORE than this - see ROUTE_TIMEOUT_MS_OVERRIDES below. A flat
// 20s ceiling here previously killed slower routes before the proxy/PiecesOS
// even got a chance to finish - a real Plan B regression vs. Plan A, found
// 2026-08-29 while sweeping every route end to end. Each override's timeout
// tracks a specific documented ceiling elsewhere in the codebase - if that
// ceiling changes, this must change with it, or the bug just found comes
// back for that one route.
const UPSTREAM_TIMEOUT_MS = 20000;
const ROUTE_TIMEOUT_MS_OVERRIDES: Array<{ test: (method: string, pathname: string) => boolean; timeoutMs: number }> = [
  // ASSETS_TIMEOUT_MS in apps/proxy/src/server.ts is 30s (a real store scan
  // that scales with asset count).
  { test: (m, p) => m === "GET" && p === "/mobile/recent/assets", timeoutMs: 35000 },
  // /assets/search (recent/search's target) got the same ASSETS_TIMEOUT_MS
  // treatment as /assets itself on 2026-08-29 - same store, same scaling.
  { test: (m, p) => m === "GET" && p === "/mobile/recent/search", timeoutMs: 35000 },
  // ASK_CLIENT_FETCH_TIMEOUT_MS in apps/mobile/src/lib/api.ts is 100s,
  // covering the Ollama fallback path (measured 24-64s in practice).
  { test: (m, p) => m === "POST" && p === "/mobile/ask", timeoutMs: 105000 },
  // SUMMARIES_CLIENT_FETCH_TIMEOUT_MS in apps/mobile/src/lib/api.ts is 30s -
  // measured fast in practice (0.4s for 21 summaries) but that measurement
  // was against an unusually low PIECES_BASE_URL round-trip; give the same
  // headroom the client itself already assumes.
  { test: (m, p) => m === "GET" && p === "/mobile/summaries", timeoutMs: 32000 },
];
function upstreamTimeoutFor(method: string, pathname: string): number {
  return ROUTE_TIMEOUT_MS_OVERRIDES.find((r) => r.test(method, pathname))?.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
}

if (!JWT_SECRET) {
  console.error("GATEWAY_JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (!HOME_PROXY_BASE_URL) {
  console.error("HOME_PROXY_BASE_URL is not set (expected the PC's Tailscale IP, e.g. http://100.x.x.x:8787).");
  process.exit(1);
}
if (!HOME_PROXY_TOKEN) {
  console.error("HOME_PROXY_TOKEN is not set (the Plan A proxy's bearer token).");
  process.exit(1);
}

// Capacitor's WebView makes requests from its own origin (typically
// https://localhost), not the gateway's own origin - without this header,
// the WebView's fetch() rejects immediately once it sees the response has no
// CORS allowance, even though the network request itself succeeded. This is
// why "could not reach proxy" showed instantly despite curl/browser working
// fine from the same network: curl and a plain browser tab don't enforce
// CORS, but a WebView's fetch() does.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS_HEADERS,
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Unauthenticated liveness check for the gateway process itself - does NOT
  // prove the home node is reachable, just that this service is up. The
  // mobile app's Setup screen should treat this as "gateway is up", separate
  // from an actual proxied call succeeding.
  if (method === "GET" && url.pathname === "/mobile/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const auth = verifyToken(req.headers.authorization, JWT_SECRET);
  if (!auth.ok) {
    sendJson(res, 401, { error: "unauthorized", reason: auth.reason });
    return;
  }

  // Ask and usage-report both need their raw POST body forwarded rather than
  // being routed through the generic allowlist below - neither maps to a
  // PiecesOS path (packages/allowlist only knows mobile-path -> PiecesOS-path
  // mappings), and both terminate at the home proxy itself. usage-report
  // forwards rather than logging locally so Plan A and Plan B events land in
  // the same file on the PC instead of splitting across two logs.
  const isAsk = method === "POST" && url.pathname === "/mobile/ask";
  const isRelevantSearch = method === "GET" && url.pathname === "/mobile/search/relevant";
  const isUsageReport = method === "POST" && url.pathname === "/mobile/usage-report";
  const isAssetFetch = method === "GET" && url.pathname.startsWith("/mobile/asset/");
  const isConversationFetch = method === "GET" && url.pathname.startsWith("/mobile/conversation/") && url.pathname.endsWith("/messages");
  // Same reasoning as isRelevantSearch: /mobile/summaries has no PiecesOS
  // path of its own (the home proxy's summaries.ts does annotation
  // hydration + SUMMARY-vs-profile filtering server-side) - a plain GET
  // passthrough to the home proxy, no special body handling needed. Missing
  // this case was a real gap (not present in the original Plan B port) -
  // the Recent ("What Got Done") tab 404'd over the gateway even though it
  // worked fine on Plan A's direct LAN connection.
  const isSummaries = method === "GET" && url.pathname === "/mobile/summaries";
  const route = isAsk || isRelevantSearch || isUsageReport || isAssetFetch || isConversationFetch || isSummaries ? { piecesPath: "" } : findAllowedRoute(method, url.pathname);

  if (!route) {
    // Deny-by-default: same allowlist module as Plan A. Anything not listed
    // there is a 404 here too, even with a valid JWT.
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const target = new URL(url.pathname + url.search, HOME_PROXY_BASE_URL);
    const upstreamReq: RequestInit & { duplex?: "half" } = {
      method,
      headers: { Authorization: `Bearer ${HOME_PROXY_TOKEN}` },
      signal: AbortSignal.timeout(upstreamTimeoutFor(method, url.pathname)),
    };
    if (isAsk || isUsageReport) {
      upstreamReq.body = req as unknown as BodyInit;
      upstreamReq.headers = { ...upstreamReq.headers, "Content-Type": "application/json" };
      // Node.js native fetch requires duplex: 'half' when streaming a body.
      upstreamReq.duplex = "half";
    }

    const homeRes = await fetch(target, upstreamReq);
    const text = await homeRes.text();
    res.writeHead(homeRes.status, {
      "Content-Type": homeRes.headers.get("content-type") ?? "application/json",
      ...CORS_HEADERS,
    });
    res.end(text);
  } catch (err) {
    // Fail closed: if the tailnet path to the home PC is down (PC asleep,
    // Tailscale down, home proxy not running because the user is logged
    // out), this returns an explicit 503 within UPSTREAM_TIMEOUT_MS rather
    // than hanging the phone indefinitely.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    sendJson(res, 503, {
      error: "home node unreachable",
      reason: isTimeout ? "timed out reaching the home proxy over Tailscale" : (err instanceof Error ? err.message : String(err)),
    });
  }
});

// 0.0.0.0, not 127.0.0.1: this runs inside a Docker container reached by
// Caddy over the compose network, not on bare metal. It is still not
// internet-facing - only exposed (not published) in docker-compose.yml, so
// only other containers on the same compose network can reach it directly.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`pieces-gateway listening on 0.0.0.0:${PORT} (reached via Caddy over the compose network, not published to the internet directly)`);
  console.log(`forwarding to home proxy at ${HOME_PROXY_BASE_URL}`);
});

// Tailscale needs to (re-)establish its direct WireGuard path/NAT punch to
// the home node after this process (re)starts - observed in practice as the
// FIRST real request timing out at the full UPSTREAM_TIMEOUT_MS even though
// every request after it is fast (a few hundred ms). Rather than let a real
// user request pay that cost, fire an unauthenticated warm-up ping against
// the home proxy's own /mobile/health at startup - result doesn't matter
// (logged only), this exists purely to wake the tunnel up early.
async function warmUpHomeProxyConnection() {
  const target = new URL("/mobile/health", HOME_PROXY_BASE_URL);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      console.log(`[warmup] home proxy reachable (attempt ${attempt}, HTTP ${res.status})`);
      return;
    } catch (err) {
      console.warn(`[warmup] home proxy not yet reachable (attempt ${attempt}/3): ${err instanceof Error ? err.message : err}`);
    }
  }
  console.warn("[warmup] gave up after 3 attempts - first real request may still pay the cold-start cost");
}
warmUpHomeProxyConnection();
