import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { semanticSearch, type SearchHit, type SearchSortMode } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";

type State =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; hits: SearchHit[]; serverSkipped: boolean; fallback: boolean }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 300;

// Server hits carry human-readable timestamps ("3 days ago"); local hits carry
// ISO strings. Format ISO strings, pass anything else through unchanged.
function formatHitTime(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export default function Search() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SearchSortMode>("hybrid");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [expanded, setExpanded] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const run = useCallback(async (q: string, sort = sortMode) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "searching" });
    try {
      const result = await semanticSearch(trimmed, { sort });
      setState({
        kind: "results",
        hits: result.hits,
        serverSkipped: result.serverSkipped,
        fallback: result.mode === "text-fallback",
      });
      setExpanded(null);
      recordEvent({
        type: "search",
        screen: "recent",
        query: trimmed,
        resultCount: result.hits.length,
        mode: result.mode === "text-fallback" ? "text-fallback" : "relevant",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [sortMode]);

  function handleSortChange(next: SearchSortMode) {
    setSortMode(next);
    if (query.trim()) {
      run(query, next);
    }
  }

  useEffect(() => {
    return () => clearTimeout(timer.current);
  }, []);

  function onChange(value: string) {
    setQuery(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(value), DEBOUNCE_MS);
  }

  function onSubmit() {
    clearTimeout(timer.current);
    run(query);
  }

  return (
    <div className="page">
      <h1>Search</h1>
      <p className="hint">Find past activity by meaning — locally captured items plus your home PC's workflow summaries when it's reachable.</p>

      <div className="card-row" style={{ gap: 8 }}>
        <input
          type="search"
          placeholder="Search your activity…"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          style={{ flex: 1 }}
        />
        <button onClick={onSubmit}>Search</button>
      </div>

      {state.kind === "searching" && <p>Searching…</p>}

      {state.kind === "error" && (
        <>
          <p className="status-error">{state.message}</p>
          <button onClick={onSubmit}>Retry</button>
        </>
      )}

      {state.kind === "results" && (
        <>
          {state.fallback && (
            <p className="hint setup-note">Meaning-based search isn't available on this device — showing text matches.</p>
          )}
          {state.serverSkipped && (
            <p className="status-error">Home PC offline — showing device results only.</p>
          )}
          {state.hits.length > 0 && (
            <div style={{ display: "flex", gap: 6, margin: "8px 0 12px", alignItems: "center", flexWrap: "wrap" }}>
              <span className="hint" style={{ fontSize: 12, marginRight: 2 }}>Sort:</span>
              <button
                type="button"
                className={sortMode === "hybrid" ? "secondary" : "ghost"}
                style={{ padding: "4px 8px", fontSize: 11, fontWeight: sortMode === "hybrid" ? 600 : 400 }}
                onClick={() => handleSortChange("hybrid")}
              >
                Recency & Relevance
              </button>
              <button
                type="button"
                className={sortMode === "recency" ? "secondary" : "ghost"}
                style={{ padding: "4px 8px", fontSize: 11, fontWeight: sortMode === "recency" ? 600 : 400 }}
                onClick={() => handleSortChange("recency")}
              >
                Newest First
              </button>
              <button
                type="button"
                className={sortMode === "relevance" ? "secondary" : "ghost"}
                style={{ padding: "4px 8px", fontSize: 11, fontWeight: sortMode === "relevance" ? 600 : 400 }}
                onClick={() => handleSortChange("relevance")}
              >
                Best Match
              </button>
            </div>
          )}
          {state.hits.length === 0 && (
            <p className="hint">Nothing matched. Captures are indexed as they're triaged — that happens when you reopen the app.</p>
          )}
          <ul>
            {state.hits.map((h, i) => (
              <li key={i} className="card clickable" onClick={() => setExpanded(expanded === i ? null : i)}>
                <div className="card-row">
                  <span className="card-title">{h.source === "local" ? "On this device" : "From home PC"}</span>
                  <span className="card-meta">{formatHitTime(h.timestamp)}</span>
                </div>
                <div className={expanded === i ? "card-body" : "card-body truncated"}>{h.text}</div>
                {h.app_label && <span className="card-meta">{h.app_label}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <nav className="tabbar">
        <button onClick={() => navigate("/setup")}>Setup</button>
        <button onClick={() => navigate("/status")}>Status</button>
        <button onClick={() => navigate("/recent")}>Recent</button>
        <button onClick={() => navigate("/ask")}>Ask</button>
      </nav>
    </div>
  );
}
