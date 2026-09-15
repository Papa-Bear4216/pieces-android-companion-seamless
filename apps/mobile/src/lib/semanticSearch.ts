import { embed, embedBatch, embedderAvailable } from "./textEmbedder";
import { readIndex } from "./captureIndex";
import {
  getWorkstreamSummaries,
  HomeNodeUnreachableError,
  ProxyNotConfiguredError,
  type WorkstreamSummary,
} from "./api";

// Thrown when embedderAvailable() said yes but embedding the query then
// failed — a genuine mid-search error the page surfaces with a Retry.
// (An embedder that's simply absent takes the text-fallback path instead
// and never throws.)
export class EmbedderUnavailableError extends Error {
  constructor() {
    super("On-device embedding failed");
    this.name = "EmbedderUnavailableError";
  }
}

export type SearchSortMode = "hybrid" | "recency" | "relevance";

export type SearchHit = {
  text: string;
  score: number; // 0..1 — dot product of L2-normalized vectors (== cosine)
  rankScore?: number; // combined recency-decayed score
  timestamp: string;
  source: "local" | "server";
  app_label?: string; // local hits only
};

export type SearchResult = {
  hits: SearchHit[];
  serverSkipped: boolean; // home node unreachable / proxy not configured
  mode: "relevant" | "text-fallback";
};

export const MIN_SCORE = 0.2;
export const DEFAULT_LIMIT = 20;

/**
 * Calculates a recency decay factor between 0.50 (floor for older items) and 1.0 (today).
 * Uses a smooth 60-day half-life decay.
 * Returns 1.0 for missing or unparseable timestamps (neutral behavior).
 */
export function computeRecencyFactor(timestamp?: string, nowMillis = Date.now()): number {
  if (!timestamp) return 1.0;
  const d = new Date(timestamp);
  const t = d.getTime();
  if (isNaN(t)) return 1.0;
  const diffMs = Math.max(0, nowMillis - t);
  const days = diffMs / (1000 * 60 * 60 * 24);
  const HALF_LIFE_DAYS = 60;
  const FLOOR = 0.5;
  const decay = Math.pow(0.5, days / HALF_LIFE_DAYS);
  return FLOOR + (1 - FLOOR) * decay;
}

export function rankHits(
  hits: SearchHit[],
  mode: SearchSortMode = "hybrid",
  limit = DEFAULT_LIMIT,
  nowMillis = Date.now(),
): SearchHit[] {
  const eligible = hits.filter((h) => h.score >= MIN_SCORE);

  if (mode === "relevance") {
    return eligible
      .sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit);
  }

  if (mode === "recency") {
    return eligible
      .sort((a, b) => {
        const tA = new Date(a.timestamp).getTime();
        const tB = new Date(b.timestamp).getTime();
        if (!isNaN(tA) && !isNaN(tB)) return tB - tA;
        return b.timestamp.localeCompare(a.timestamp) || b.score - a.score;
      })
      .slice(0, limit);
  }

  // "hybrid" — recency-weighted relevance ("recency then relevance")
  return eligible
    .map((h) => ({
      ...h,
      rankScore: h.score * computeRecencyFactor(h.timestamp, nowMillis),
    }))
    .sort((a, b) => (b.rankScore ?? b.score) - (a.rankScore ?? a.score) || b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

// Session cache of server-summary vectors, keyed by summary id. Server
// summaries live authoritatively on the home node and change server-side,
// so their vectors are never persisted to captureIndex — only memoized for
// the lifetime of this module (one app session).
const serverVectorCache = new Map<string, number[]>();

/** @internal test-only — clears the session cache so tests don't leak vectors across cases */
export function __resetServerCache(): void {
  serverVectorCache.clear();
}

function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function summaryText(s: WorkstreamSummary): string {
  return `${s.name}\n${s.text}`;
}

export async function semanticSearch(
  query: string,
  opts?: { limit?: number; sort?: SearchSortMode },
): Promise<SearchResult> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const sortMode = opts?.sort ?? "hybrid";
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], serverSkipped: false, mode: "relevant" };

  if (!(await embedderAvailable())) {
    return textFallback(trimmed, limit, sortMode);
  }

  const queryEmb = await embed(trimmed);
  if (!queryEmb.ok) throw new EmbedderUnavailableError();
  const q = queryEmb.vector;

  const hits: SearchHit[] = [];

  // Local index
  const index = await readIndex();
  for (const entry of index) {
    hits.push({
      text: entry.text,
      score: dot(q, entry.vector),
      timestamp: entry.timestamp,
      source: "local",
      app_label: entry.app_label,
    });
  }

  // Server summaries
  let serverSkipped = false;
  try {
    const summaries = await getWorkstreamSummaries();
    const missing = summaries.filter((s) => !serverVectorCache.has(s.id));
    if (missing.length > 0) {
      const vectors = await embedBatch(missing.map(summaryText));
      missing.forEach((s, i) => {
        const v = vectors[i];
        if (v) serverVectorCache.set(s.id, v);
      });
    }
    for (const s of summaries) {
      const v = serverVectorCache.get(s.id);
      if (!v) continue;
      hits.push({
        text: s.text,
        score: dot(q, v),
        timestamp: s.created,
        source: "server",
      });
    }
  } catch (err) {
    if (err instanceof HomeNodeUnreachableError || err instanceof ProxyNotConfiguredError) {
      serverSkipped = true;
    } else {
      throw err;
    }
  }

  const ranked = rankHits(hits, sortMode, limit);
  return { hits: ranked, serverSkipped, mode: "relevant" };
}

async function textFallback(query: string, limit: number, sortMode: SearchSortMode = "hybrid"): Promise<SearchResult> {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];

  const index = await readIndex();
  for (const entry of index) {
    if (entry.text.toLowerCase().includes(needle)) {
      hits.push({
        text: entry.text,
        score: 1,
        timestamp: entry.timestamp,
        source: "local",
        app_label: entry.app_label,
      });
    }
  }

  let serverSkipped = false;
  try {
    const summaries = await getWorkstreamSummaries();
    for (const s of summaries) {
      if (summaryText(s).toLowerCase().includes(needle)) {
        hits.push({ text: s.text, score: 1, timestamp: s.created, source: "server" });
      }
    }
  } catch (err) {
    if (err instanceof HomeNodeUnreachableError || err instanceof ProxyNotConfiguredError) {
      serverSkipped = true;
    } else {
      throw err;
    }
  }

  const ranked = rankHits(hits, sortMode, limit);
  return {
    hits: ranked,
    serverSkipped,
    mode: "text-fallback",
  };
}
