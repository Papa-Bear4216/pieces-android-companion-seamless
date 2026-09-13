import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";
import { PiecesClient } from "@pieces-android/pieces-api";
import { findAllowedRoute } from "@pieces-android/allowlist";
import { isValidBearerToken } from "./auth.ts";
import { summarizeTelemetry, androidTimelineReadable, seedToPiecesOS, seedWorkstreamEvent, TelemetryEvent } from "./seeder.ts";
import { SeedQueue } from "./seed-queue.js";
import { shouldSeed } from "./surprisal.js";
import { askOllamaFallback } from "./ollama-fallback.js";
import { listWorkstreamSummaries } from "./summaries.js";
import { MemoryClient } from "mem0ai";

// Mem0 integration is optional — most PiecesOS users won't have an account.
// Unset MEM0_API_KEY entirely disables it; failures are always non-fatal
// (logged and swallowed) so a bad/expired key never breaks the proxy itself.
const MEM0_API_KEY = process.env.MEM0_API_KEY;
const MEM0_USER_ID = process.env.MEM0_USER_ID ?? "pieces-android-user";
const mem0Client = MEM0_API_KEY ? new MemoryClient({ apiKey: MEM0_API_KEY }) : null;

const REGISTRY_INGEST_URL = process.env.REGISTRY_INGEST_URL;
const REGISTRY_AUTH_TOKEN = process.env.REGISTRY_AUTH_TOKEN;

async function addToMem0(content: string) {
  if (!mem0Client) return;
  try {
    await mem0Client.add([{ role: "user", content }], { user_id: MEM0_USER_ID });
  } catch (e) {
    console.warn("Failed to save to Mem0", e);
  }
}

// Optional (merged from shizuku-monitor): forward a coarse usage record for
// each seeded batch to registry-app's /ingest, feeding its pattern engine.
// Env-gated (REGISTRY_INGEST_URL unset => no-op) and always non-fatal.
const REGISTRY_INGEST_URL = process.env.REGISTRY_INGEST_URL;
const REGISTRY_AUTH_TOKEN = process.env.REGISTRY_AUTH_TOKEN;

async function pipeToRegistryApp(batch: TelemetryEvent[], packageName: string, appLabel?: string) {
  if (!REGISTRY_INGEST_URL) return;
  try {
    const timestamp = batch[0]?.timestamp || new Date().toISOString();
    const idempotencyKey = `shizuku-${packageName}-${timestamp}-${batch.length}`;
    let usageDurationMs = 0;
    if (batch.length > 1 && batch[0]?.timestamp && batch[batch.length - 1]?.timestamp) {
      const t0 = new Date(batch[0].timestamp).getTime();
      const t1 = new Date(batch[batch.length - 1].timestamp).getTime();
      if (!isNaN(t0) && !isNaN(t1)) usageDurationMs = Math.max(0, Math.abs(t1 - t0));
      if (!isNaN(t0) && !isNaN(t1)) {
        usageDurationMs = Math.max(0, Math.abs(t1 - t0));
      }
    }
    const payload = {
      collector: process.env.REGISTRY_COLLECTOR_TYPE || "shizuku",
      sourceId: process.env.SHIZUKU_DEVICE_ID || "shizuku-companion-device",
      sourceLabel: "Shizuku Monitor",
      rawLabel: appLabel || packageName,
      rawIdentity: packageName,
      idempotencyKey,
      payload: { usageCount: batch.length, usageDurationMs, windowHours: 1 },
      payload: {
        usageCount: batch.length,
        usageDurationMs,
        windowHours: 1,
      },
    };
    await fetch(REGISTRY_INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(REGISTRY_AUTH_TOKEN ? { Authorization: `Bearer ${REGISTRY_AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn("Failed to pipe telemetry to registry-app:", err);
  }
}

// Observed in practice (2026-08-29): a pooled keep-alive socket to PiecesOS
// occasionally dies without either side sending FIN/RST (UND_ERR_SOCKET
// "other side closed" surfaced from a workstream-event seed call), and
// undici's default keep-alive tries to reuse it anyway. A short
// keepAliveTimeout forces a fresh socket often enough that a dead one is
// very unlikely to still be sitting in the pool when the next request goes
// out. See the matching fix + longer writeup in apps/pieces-gateway/src/server.ts.
setGlobalDispatcher(new Agent({ keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000 }));

const UPSTREAM_TIMEOUT_MS = 5000;
// PiecesOS's /assets does a real store scan that scales with asset count —
// measured directly at 13s against PiecesOS with 276 assets (was ~5.3s when
// this was first raised at a lower asset count). 20s started timing out in
// practice through the full phone->proxy->PiecesOS->proxy->phone round trip
// even though a direct PiecesOS call finished under it — raised with margin
// rather than tuned to today's exact count, since this list only grows.
const ASSETS_TIMEOUT_MS = 30000;

// Deliberately outside the repo (which lives under OneDrive) — this file can
// contain real query/question text and must never be committed or synced.
const USAGE_LOG_PATH =
  process.env.USAGE_LOG_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-usage-log.jsonl`;
const MAX_EVENTS_PER_BATCH = 500;
// Guards against a pathological batch (500 events each carrying a large
// text-node dump — a webview or scrollable list can produce tens of KB per
// event) stalling the proxy on body accumulation before the event-count
// check even runs. 10MB comfortably covers 500 realistic telemetry events
// (each capped at MAX_TEXT_CHARS=20,000 chars natively) with headroom.
const MAX_USAGE_REPORT_BODY_BYTES = 10 * 1024 * 1024;

const PORT = Number(process.env.PROXY_PORT ?? 8787);
const PIECES_BASE_URL = process.env.PIECES_BASE_URL ?? "http://127.0.0.1:39300";
const BEARER_TOKEN = process.env.PROXY_BEARER_TOKEN;

// Anything that fails to seed into PiecesOS (e.g. it's restarting) lands
// here instead of being silently dropped — a background loop retries it
// until it succeeds or MAX_ATTEMPTS is hit. USAGE_LOG_PATH still gets every
// event unconditionally regardless of seed outcome, so this queue is purely
// about reconciling into PiecesOS, not about not losing the data at all.
const SEED_QUEUE_PATH =
  process.env.SEED_QUEUE_PATH ?? `${process.env.USERPROFILE ?? process.env.HOME}\\.claude\\pieces-seed-queue.jsonl`;
const seedQueue = new SeedQueue(SEED_QUEUE_PATH, PIECES_BASE_URL);

if (!BEARER_TOKEN) {
  console.error(
    "PROXY_BEARER_TOKEN is not set. Refusing to start — this proxy must never run without auth. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  );
  process.exit(1);
}

const pieces = new PiecesClient({ baseUrl: PIECES_BASE_URL });

// Capacitor's WebView makes requests from its own origin (typically
// https://localhost), not the proxy's origin - without this header, the
// WebView's fetch() rejects immediately once it sees the response has no
// CORS allowance, even though the network request itself succeeded.
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

  // /mobile/health is intentionally unauthenticated — a bare liveness check
  // for the app's Setup screen before a token has been entered. It reveals
  // nothing about PiecesOS itself, just that the proxy process is up.
  if (method === "GET" && url.pathname === "/mobile/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isValidBearerToken(req.headers.authorization, BEARER_TOKEN)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  // Ask is not a plain passthrough — it needs PiecesClient.ask()'s typed
  // unavailable-vs-answered handling, so it's special-cased rather than
  // routed through the generic allowlist proxy below.
  if (method === "POST" && url.pathname === "/mobile/ask") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let query: string;
    try {
      query = JSON.parse(body)?.query;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (typeof query !== "string" || query.trim() === "") {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    
    // Same novelty gate the telemetry path uses, so every Mem0 write goes
    // through one consistent dedup rule instead of ask queries bypassing it.
    // Fixed bucket key since queries aren't tied to an Android package.
    const novel = await shouldSeed("__ask_queries__", query);
    if (novel) {
      await addToMem0(query);
    }

    const result = await pieces.ask(query);
    if (result.status === "unavailable") {
      // pieces.ask() is unavailable — currently always, since the account's
      // cloud allocation is broken (docs/ALLOWED_ROUTES.md's "Ask root cause"
      // section). Try a local, Pieces-data-grounded fallback rather than
      // surfacing a dead end; never worse than the original result if it fails.
      const fallback = await askOllamaFallback(pieces, PIECES_BASE_URL, query);
      sendJson(res, 200, fallback.status === "answered" ? fallback : result);
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  // "What got done" — PiecesOS's own workstream-summary rollups, not raw
  // captured telemetry. Special-cased (not in the generic allowlist) because
  // it needs the annotation-hydration + SUMMARY-vs-profile filtering in
  // summaries.ts, not a raw passthrough.
  if (method === "GET" && url.pathname === "/mobile/summaries") {
    try {
      const summaries = await listWorkstreamSummaries(PIECES_BASE_URL);
      sendJson(res, 200, { summaries });
    } catch (err) {
      sendJson(res, 502, { error: "Failed to load workstream summaries", detail: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Semantic (embeddings-based) search, distinct from /mobile/recent/search's
  // plain text match — special-cased like /mobile/ask because it needs
  // PiecesClient.relevantAssets()'s ID-hydration step, not a raw passthrough.
  if (method === "GET" && url.pathname === "/mobile/search/relevant") {
    const query = url.searchParams.get("query");
    if (!query || query.trim() === "") {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    try {
      const results = await pieces.relevantAssets(query);
      sendJson(res, 200, { iterable: results });
    } catch (err) {
      sendJson(res, 502, { error: "PiecesOS relevance search failed", detail: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Not a PiecesOS route — terminates here and writes to the local usage log.
  // Special-cased for the same reason /mobile/ask is: packages/allowlist maps
  // mobile paths to PiecesOS paths, and this route has no PiecesOS counterpart.
  if (method === "POST" && url.pathname === "/mobile/usage-report") {
    let body = "";
    let bodyTooLarge = false;
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_USAGE_REPORT_BODY_BYTES) {
        bodyTooLarge = true;
        break;
      }
    }
    if (bodyTooLarge) {
      req.destroy();
      sendJson(res, 413, { error: `request body too large (max ${MAX_USAGE_REPORT_BODY_BYTES} bytes)` });
      return;
    }
    let events: unknown;
    try {
      events = JSON.parse(body)?.events;
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    if (!Array.isArray(events) || events.length === 0) {
      sendJson(res, 400, { error: "events array is required" });
      return;
    }
    if (events.length > MAX_EVENTS_PER_BATCH) {
      sendJson(res, 400, { error: `batch too large (max ${MAX_EVENTS_PER_BATCH})` });
      return;
    }
    try {
      await mkdir(dirname(USAGE_LOG_PATH), { recursive: true });
      const lines = (events as any[]).map((e) => JSON.stringify(e)).join("\n") + "\n";
      await appendFile(USAGE_LOG_PATH, lines, "utf-8");
      
      // Batch consecutive same-package system_telemetry events in this
      // request into a single seed instead of one seed call per event — a
      // scroll-heavy burst that survives client-side dedup previously wrote
      // to both Mem0 and PiecesOS once per surviving event.
      //
      // `package` is a first-class field on newer clients (passiveCapture.ts,
      // Status.tsx's manual scan). Older/not-yet-updated clients only embed
      // it as "Package: <name>\n\n<text>" inside `telemetry` — kept as a
      // fallback so this doesn't regress for anyone running a not-yet-rebuilt
      // APK.
      const packageOf = (e: TelemetryEvent): string => {
        if (e.package) return e.package;
        const match = /^Package:\s*(\S+)/.exec(e.telemetry ?? "");
        return match ? match[1] : "unknown";
      };

      const telemetryEvents = (events as TelemetryEvent[]).filter((e) => e.type === "system_telemetry");
      const batches: TelemetryEvent[][] = [];
      for (const e of telemetryEvents) {
        const last = batches[batches.length - 1];
        if (last && packageOf(last[0]) === packageOf(e)) {
          last.push(e);
        } else {
          batches.push([e]);
        }
      }

      for (const batch of batches) {
        const packageName = packageOf(batch[0]);
        const bodyText =
          batch.length === 1
            ? summarizeTelemetry(batch[0])
            : batch.map((e) => summarizeTelemetry(e)).join("\n\n===\n\n");
        const rawTelemetry = batch[0]?.telemetry ?? "";
        const actionMatch = rawTelemetry.match(/ACTION:\s*(.+)/)?.[1]?.trim();
        const title = actionMatch
          ? `Android Activity: ${actionMatch}`
          : batch.length === 1
            ? "Android Context: System Telemetry"
            : `Android Context: System Telemetry (${batch.length} events batched)`;

        // Surprisal gate: skip seeding near-duplicate/unsurprising content.
        // Fails open (see surprisal.ts) — never a silent data-loss path.
        const novel = await shouldSeed(packageName, bodyText);
        if (!novel) continue;

        await addToMem0(bodyText);
        await pipeToRegistryApp(batch, packageName, batch[0]?.app_label);

        // Ambient workstream telemetry is routed strictly to WorkstreamEvents.
        // Asset creation (/assets/create) is skipped for Nano action streams to avoid store bloat.
        if (!actionMatch) {
          try {
            await seedToPiecesOS(PIECES_BASE_URL, bodyText, title);
          } catch (err) {
            console.warn("PiecesOS not reachable for seeding; queued for retry.", err);
            await seedQueue.enqueue(bodyText, title, "asset");
          }
        }

        // Also write to the workstream-event stream (feeds PiecesOS's own
        // timeline/rollup generation, which assets alone don't). Queued for
        // retry on the same durable queue as the asset write above —
        // SeedQueue dispatches by kind, so a failed workstream-event write
        // gets the same reconciliation guarantee instead of being silently
        // lost if PiecesOS happens to be down for this specific write and
        // not the asset write moments earlier.
        //
        // If an on-device Gemini Nano action block is present, send the clean
        // formatted summary (bodyText) directly into the workstream timeline;
        // otherwise fall back to the [Android · <app>] summary.
        const timelineReadable =
          actionMatch
            ? bodyText
            : batch.length === 1
              ? androidTimelineReadable(batch[0])
              : batch.map((e) => androidTimelineReadable(e)).join("\n\n");
        try {
          await seedWorkstreamEvent(PIECES_BASE_URL, timelineReadable);
        } catch (err) {
          console.warn("PiecesOS not reachable for workstream event; queued for retry.", err);
          await seedQueue.enqueue(timelineReadable, "", "workstream_event");
        }
      }

      sendJson(res, 200, { accepted: (events as any[]).length });
    } catch (err) {
      sendJson(res, 500, { error: "failed to persist usage events", detail: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Specialized route for fetching a specific asset's content by ID
  if (method === "GET" && url.pathname.startsWith("/mobile/asset/")) {
    const assetId = url.pathname.split("/").pop();
    if (!assetId) {
      sendJson(res, 400, { error: "missing asset ID" });
      return;
    }
    try {
      const target = new URL(`/asset/${assetId}`, PIECES_BASE_URL);
      const piecesRes = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const text = await piecesRes.text();
      res.writeHead(piecesRes.status, {
        "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
        ...CORS_HEADERS,
      });
      res.end(text);
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      sendJson(res, isTimeout ? 503 : 502, {
        error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Specialized route for fetching a conversation's messages
  if (method === "GET" && url.pathname.startsWith("/mobile/conversation/") && url.pathname.endsWith("/messages")) {
    const convoId = url.pathname.split("/")[3];
    if (!convoId) {
      sendJson(res, 400, { error: "missing conversation ID" });
      return;
    }
    try {
      const target = new URL(`/conversation/${convoId}/messages`, PIECES_BASE_URL);
      const piecesRes = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      const text = await piecesRes.text();
      res.writeHead(piecesRes.status, {
        "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
        ...CORS_HEADERS,
      });
      res.end(text);
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      sendJson(res, isTimeout ? 503 : 502, {
        error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  const route = findAllowedRoute(method, url.pathname);
  if (!route) {
    // Deny-by-default: anything not explicitly listed in allowlist.ts is a 404,
    // not proxied. Do not add a catch-all fallback here.
    sendJson(res, 404, { error: "not found" });
    return;
  }

  try {
    const target = new URL(route.piecesPath, PIECES_BASE_URL);
    target.search = url.search;
    // /assets does a real store scan and can legitimately take several
    // seconds on a non-trivial asset count — 5s was tight enough to
    // routinely time out a request PiecesOS was about to complete
    // successfully (observed: consistent ~5.3s, PiecesOS itself returning
    // 200). /assets/search (recent/search's target) does the same kind of
    // real scan over the same growing asset count and was still on the
    // tighter default until 2026-08-29's route sweep caught it — same class
    // of bug as the gateway's flat timeout, just one layer in. Other routes
    // stay on the tighter default.
    const timeoutMs = route.piecesPath === "/assets" || route.piecesPath === "/assets/search" ? ASSETS_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS;
    const piecesRes = await fetch(target, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await piecesRes.text();
    res.writeHead(piecesRes.status, {
      "Content-Type": piecesRes.headers.get("content-type") ?? "application/json",
      ...CORS_HEADERS,
    });
    res.end(text);
  } catch (err) {
    // Fail closed: a hung/unreachable PiecesOS must return an explicit 503
    // within UPSTREAM_TIMEOUT_MS, not leave the caller hanging indefinitely.
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    sendJson(res, isTimeout ? 503 : 502, {
      error: isTimeout ? "PiecesOS timed out" : "PiecesOS unreachable",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`pieces-android proxy listening on 0.0.0.0:${PORT} (LAN, private-profile firewall assumed)`);
  console.log(`proxying to PiecesOS at ${PIECES_BASE_URL}`);
});

// A client disconnecting mid-request (flaky WiFi, phone sleep, app backgrounded)
// throws ECONNRESET from inside Node's HTTP internals — outside any try/catch
// in our own request handler. Left uncaught, this kills the whole process, so
// the proxy has been silently dying under completely normal phone network
// flakiness rather than staying up like a long-running service should.
process.on("uncaughtException", (err) => {
  console.error("[proxy] uncaught exception (ignoring, staying alive):", err);
});

// Also drain once on startup — covers the case where the proxy itself was
// down (not just PiecesOS) and items piled up while nothing was retrying.
seedQueue.drain().catch((err) => console.warn("[seed-queue] initial drain failed", err));
seedQueue.startRetryLoop();
