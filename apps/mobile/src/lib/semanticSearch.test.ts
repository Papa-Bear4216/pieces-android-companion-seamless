import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./textEmbedder", () => ({
  embed: vi.fn(),
  embedBatch: vi.fn(),
  embedderAvailable: vi.fn(),
}));
vi.mock("./captureIndex", () => ({
  readIndex: vi.fn(),
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, getWorkstreamSummaries: vi.fn() };
});

import { embed, embedBatch, embedderAvailable } from "./textEmbedder";
import { readIndex } from "./captureIndex";
import { getWorkstreamSummaries, HomeNodeUnreachableError, ProxyNotConfiguredError } from "./api";
import { semanticSearch, EmbedderUnavailableError, MIN_SCORE, __resetServerCache } from "./semanticSearch";

beforeEach(() => {
  vi.clearAllMocks();
  __resetServerCache();
  vi.mocked(embedderAvailable).mockResolvedValue(true);
  vi.mocked(getWorkstreamSummaries).mockResolvedValue([]);
  vi.mocked(embedBatch).mockResolvedValue([]);
});

describe("semanticSearch", () => {
  test("ranks local hits by cosine (dot product of normalized vectors), descending", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "near", vector: [0.9, 0.1], timestamp: "t1", source: "local" },
      { id: "local:b", text: "far", vector: [0.1, 0.9], timestamp: "t2", source: "local" },
      { id: "local:c", text: "exact", vector: [1, 0], timestamp: "t3", source: "local" },
    ]);
    const res = await semanticSearch("q");
    expect(res.hits.map((h) => h.text)).toEqual(["exact", "near"]); // "far" (0.1) below MIN_SCORE 0.2
    expect(res.hits[0].score).toBeGreaterThan(res.hits[1].score);
    expect(res.mode).toBe("relevant");
  });

  test("drops hits below MIN_SCORE", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "weak", vector: [MIN_SCORE - 0.05, 1], timestamp: "t", source: "local" },
    ]);
    const res = await semanticSearch("q");
    expect(res.hits).toHaveLength(0);
  });

  test("throws EmbedderUnavailableError when query embed fails but embedder reported available", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: false });
    await expect(semanticSearch("q")).rejects.toBeInstanceOf(EmbedderUnavailableError);
  });

  test("home node unreachable → serverSkipped true, local hits still returned", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "local hit", vector: [1, 0], timestamp: "t", source: "local" },
    ]);
    vi.mocked(getWorkstreamSummaries).mockRejectedValue(new HomeNodeUnreachableError("offline"));
    const res = await semanticSearch("q");
    expect(res.serverSkipped).toBe(true);
    expect(res.hits.map((h) => h.text)).toEqual(["local hit"]);
  });

  test("server summaries are embedded and merged with a 'server' source", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([]);
    vi.mocked(getWorkstreamSummaries).mockResolvedValue([
      { id: "s1", name: "Report", created: "y", text: "wrote the report" },
    ]);
    vi.mocked(embedBatch).mockResolvedValue([[1, 0]]);
    const res = await semanticSearch("q");
    expect(res.hits).toHaveLength(1);
    expect(res.hits[0]).toMatchObject({ text: "wrote the report", source: "server" });
    // Verify embedBatch was called with the exact name+text format
    expect(vi.mocked(embedBatch)).toHaveBeenCalledWith(["Report\nwrote the report"]);
    // Second call should hit the cache and not call embedBatch again
    vi.mocked(embedBatch).mockClear();
    const res2 = await semanticSearch("q");
    expect(res2.hits).toHaveLength(1);
    expect(vi.mocked(embedBatch)).not.toHaveBeenCalled();
  });

  test("index entry with a mismatched vector length scores 0 and is dropped", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:stale", text: "stale model entry", vector: [1, 0, 0, 0], timestamp: "t1", source: "local" },
      { id: "local:good", text: "current entry", vector: [1, 0], timestamp: "t2", source: "local" },
    ]);
    const res = await semanticSearch("q");
    expect(res.hits.map((h) => h.text)).toEqual(["current entry"]);
  });

  test("ProxyNotConfiguredError → serverSkipped true, local hits still returned, no throw", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "local hit", vector: [1, 0], timestamp: "t", source: "local" },
    ]);
    vi.mocked(getWorkstreamSummaries).mockRejectedValue(new ProxyNotConfiguredError());
    const res = await semanticSearch("q");
    expect(res.serverSkipped).toBe(true);
    expect(res.hits.map((h) => h.text)).toEqual(["local hit"]);
  });

  test("text-fallback SERVER branch: substring-matched summary appears as a server hit, sorted by timestamp desc", async () => {
    vi.mocked(embedderAvailable).mockResolvedValue(false);
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "local lamp note", vector: [], timestamp: "2026-01-01T00:00:00Z", source: "local" },
    ]);
    vi.mocked(getWorkstreamSummaries).mockResolvedValue([
      { id: "s1", name: "Lamp shopping", created: "2026-03-01T00:00:00Z", text: "compared lamp prices" },
    ]);
    const res = await semanticSearch("lamp");
    expect(res.mode).toBe("text-fallback");
    expect(res.hits.map((h) => h.source)).toEqual(["server", "local"]);
    expect(res.hits[0]).toMatchObject({ source: "server", text: "compared lamp prices" });
    expect(embed).not.toHaveBeenCalled();
  });

  test("honors opts.limit", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        id: `local:${i}`,
        text: `hit ${i}`,
        vector: [1, 0] as number[],
        timestamp: `t${i}`,
        source: "local" as const,
      })),
    );
    const res = await semanticSearch("q", { limit: 5 });
    expect(res.hits).toHaveLength(5);
  });

  test("empty and whitespace queries return empty results without calling embed", async () => {
    const emptyRes = await semanticSearch("");
    expect(emptyRes).toEqual({ hits: [], serverSkipped: false, mode: "relevant" });
    expect(vi.mocked(embed)).not.toHaveBeenCalled();

    vi.mocked(embed).mockClear();
    const whitespaceRes = await semanticSearch("   ");
    expect(whitespaceRes).toEqual({ hits: [], serverSkipped: false, mode: "relevant" });
    expect(vi.mocked(embed)).not.toHaveBeenCalled();
  });

  test("non-Home/Proxy server error is rethrown, not swallowed", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([]);
    const serverError = new Error("boom");
    vi.mocked(getWorkstreamSummaries).mockRejectedValue(serverError);
    await expect(semanticSearch("q")).rejects.toThrow(serverError);
  });

  test("text-fallback path when embedder unavailable: substring match, mode text-fallback", async () => {
    vi.mocked(embedderAvailable).mockResolvedValue(false);
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:a", text: "bought a lamp", vector: [], timestamp: "t1", source: "local" },
      { id: "local:b", text: "read the news", vector: [], timestamp: "t2", source: "local" },
    ]);
    const res = await semanticSearch("LAMP");
    expect(res.mode).toBe("text-fallback");
    expect(res.hits.map((h) => h.text)).toEqual(["bought a lamp"]);
    expect(embed).not.toHaveBeenCalled();
  });

  test("hybrid mode prioritizes recent items over older slightly higher-scoring items", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    // Old item from 2 years ago has higher raw vector similarity (0.85)
    // Recent item from today has slightly lower raw similarity (0.80)
    const twoYearsAgo = new Date(Date.now() - 730 * 86400 * 1000).toISOString();
    const today = new Date().toISOString();

    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:old", text: "old match", vector: [0.85, 0.15], timestamp: twoYearsAgo, source: "local" },
      { id: "local:recent", text: "recent match", vector: [0.80, 0.20], timestamp: today, source: "local" },
    ]);

    const res = await semanticSearch("q", { sort: "hybrid" });
    expect(res.hits.map((h) => h.text)).toEqual(["recent match", "old match"]);
  });

  test("sort: 'recency' orders strictly by timestamp newest first", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:1", text: "2024 hit", vector: [0.9, 0.1], timestamp: "2024-01-01T00:00:00Z", source: "local" },
      { id: "local:2", text: "2026 hit", vector: [0.5, 0.5], timestamp: "2026-01-01T00:00:00Z", source: "local" },
      { id: "local:3", text: "2022 hit", vector: [0.99, 0.01], timestamp: "2022-01-01T00:00:00Z", source: "local" },
    ]);

    const res = await semanticSearch("q", { sort: "recency" });
    expect(res.hits.map((h) => h.text)).toEqual(["2026 hit", "2024 hit", "2022 hit"]);
  });

  test("sort: 'relevance' orders strictly by cosine similarity regardless of date", async () => {
    vi.mocked(embed).mockResolvedValue({ ok: true, vector: [1, 0] });
    vi.mocked(readIndex).mockResolvedValue([
      { id: "local:1", text: "2026 hit", vector: [0.5, 0.5], timestamp: "2026-01-01T00:00:00Z", source: "local" },
      { id: "local:2", text: "2022 hit", vector: [0.99, 0.01], timestamp: "2022-01-01T00:00:00Z", source: "local" },
    ]);

    const res = await semanticSearch("q", { sort: "relevance" });
    expect(res.hits.map((h) => h.text)).toEqual(["2022 hit", "2026 hit"]);
  });
});
