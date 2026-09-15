import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PiecesClient } from "@pieces-android/pieces-api";

// Fallback for Pieces Ask endpoint using Gemini Flash via Antigravity (agy agentapi).
// Requires NO API key, zero Ollama overhead, and returns grounded answers in seconds.

const AGY_PATH = process.env.AGY_PATH ?? "C:\\Users\\micha\\AppData\\Local\\agy\\bin\\agy.exe";
const WORKSTREAM_EVENTS_TIMEOUT_MS = 15000;
const MAX_ASSET_SNIPPETS = 6;
const MAX_EVENT_SNIPPETS = 8;
const MAX_SNIPPET_CHARS = 500;

export type GeminiFallbackResult =
  | { status: "answered"; answers: string; source: "gemini-antigravity"; groundedSnippetCount: number }
  | { status: "unavailable"; reason: string };

type WorkstreamEvent = {
  readable?: string;
  updated?: { value?: string };
  created?: { value?: string };
};

function keywordsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length >= 3);
}

function matchScore(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((score, word) => (lower.includes(word) ? score + 1 : score), 0);
}

async function fetchRelevantWorkstreamEvents(piecesBaseUrl: string, query: string): Promise<string[]> {
  const res = await fetch(`${piecesBaseUrl.replace(/\/$/, "")}/workstream_events`, {
    signal: AbortSignal.timeout(WORKSTREAM_EVENTS_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  const iterable: WorkstreamEvent[] = Array.isArray(body?.iterable) ? body.iterable : [];

  const keywords = keywordsOf(query);
  const scored = iterable
    .map((e) => ({ event: e, score: keywords.length === 0 ? 0 : matchScore(e.readable ?? "", keywords) }))
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = a.event.updated?.value ?? a.event.created?.value ?? "";
    const bTime = b.event.updated?.value ?? b.event.created?.value ?? "";
    return bTime.localeCompare(aTime);
  });

  return scored
    .slice(0, MAX_EVENT_SNIPPETS)
    .map(({ event }) => (event.readable ?? "").slice(0, MAX_SNIPPET_CHARS));
}

async function gatherContext(pieces: PiecesClient, piecesBaseUrl: string, query: string): Promise<string[]> {
  const [assets, events] = await Promise.all([
    pieces.relevantAssets(query).catch(() => []),
    fetchRelevantWorkstreamEvents(piecesBaseUrl, query).catch(() => []),
  ]);

  const assetSnippets = assets.slice(0, MAX_ASSET_SNIPPETS).map((a) => {
    let snippet = `Asset: ${a.name} (updated ${a.updated})`;
    if (a.content) {
      snippet += `\n${a.content.slice(0, MAX_SNIPPET_CHARS)}`;
    }
    return snippet;
  });

  return [...assetSnippets, ...events];
}

function callGeminiViaAgy(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      AGY_PATH,
      ["-p", prompt, "--model", "gemini-3.7-flash-low"],
      { timeout: 45000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          console.error("[callGeminiViaAgy] error:", err, stderr);
          return reject(new Error(`agy CLI error: ${err.message}${stderr ? " - " + stderr : ""}`));
        }
        const reply = stdout.trim();
        if (!reply) {
          return reject(new Error("Empty reply returned from agy"));
        }
        resolve(reply);
      },
    );
  });
}

export async function askGeminiFallback(
  pieces: PiecesClient,
  piecesBaseUrl: string,
  query: string,
): Promise<GeminiFallbackResult> {
  try {
    const snippets = await gatherContext(pieces, piecesBaseUrl, query);

    const prompt =
      snippets.length > 0
        ? [
            "You are answering a user question using ONLY the notes below, pulled from the user's Pieces memory.",
            "If the notes do not contain the answer, say so clearly instead of guessing.",
            "",
            "--- User's Pieces Memory Notes ---",
            ...snippets.map((s, i) => `[${i + 1}] ${s}`),
            "--- End Notes ---",
            "",
            `Question: ${query}`,
          ].join("\n")
        : [
            "No matching notes were found in the user's Pieces memory for this question.",
            "Say that plainly, then provide a helpful response from general knowledge while clarifying that it is not in their saved Pieces data.",
            "",
            `Question: ${query}`,
          ].join("\n");

    const answer = await callGeminiViaAgy(prompt);

    return {
      status: "answered",
      answers: answer,
      source: "gemini-antigravity",
      groundedSnippetCount: snippets.length,
    };
  } catch (err) {
    console.error("[gemini-fallback] failed:", err);
    return {
      status: "unavailable",
      reason: `Gemini fallback failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
