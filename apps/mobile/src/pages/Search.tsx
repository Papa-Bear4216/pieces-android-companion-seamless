import { useCallback, useEffect, useRef, useState } from "react";
import { semanticSearch, type SearchHit, type SearchSortMode } from "../lib/semanticSearch";
import { recordEvent } from "../lib/usage";
import { SearchIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from "../components/Icons";

type State =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "results"; hits: SearchHit[]; serverSkipped: boolean; fallback: boolean }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 400;

// Server hits carry human-readable timestamps ("3 days ago"); local hits carry
// ISO strings. Format ISO strings, pass anything else through unchanged.
function formatHitTime(ts: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export default function Search() {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SearchSortMode>("hybrid");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [expanded, setExpanded] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeRequestId = useRef(0);

  const run = useCallback(async (q: string, sort = sortMode) => {
    const trimmed = q.trim();
    if (!trimmed) {
      activeRequestId.current++;
      setState({ kind: "idle" });
      return;
    }
    const reqId = ++activeRequestId.current;
    setState({ kind: "searching" });
    try {
      const result = await semanticSearch(trimmed, { sort });
      if (reqId !== activeRequestId.current) {
        // Stale search response superseded by a newer query
        return;
      }
      setState({
        kind: "results",
        hits: result.hits,
        serverSkipped: result.serverSkipped,
        fallback: result.mode === "text-fallback",
      });
      setExpanded(null);
      recordEvent({
        type: "search",
        screen: "search",
        query: trimmed,
        resultCount: result.hits.length,
        mode: result.mode === "text-fallback" ? "text-fallback" : "relevant",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      if (reqId !== activeRequestId.current) return;
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
    if (!value.trim()) {
      activeRequestId.current++;
      setState({ kind: "idle" });
      return;
    }
    timer.current = setTimeout(() => run(value), DEBOUNCE_MS);
  }

  function onSubmit() {
    clearTimeout(timer.current);
    if (query.trim()) {
      run(query);
    }
  }

  function clearQuery() {
    clearTimeout(timer.current);
    activeRequestId.current++;
    setQuery("");
    setState({ kind: "idle" });
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Search Activity</h1>
        <p className="hint">
          Find past activity by meaning — locally captured items plus your home PC's workflow summaries when reachable.
        </p>
      </div>

      <div className="card-row" style={{ gap: 8, marginBottom: 12 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <input
            type="search"
            placeholder="Search your activity…"
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            style={{ margin: 0, paddingLeft: 38, paddingRight: query ? 36 : 14 }}
          />
          <SearchIcon
            size={18}
            style={{
              position: "absolute",
              left: 12,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-dim)",
              pointerEvents: "none",
            }}
          />
          {query && (
            <button
              type="button"
              className="ghost"
              onClick={clearQuery}
              style={{
                position: "absolute",
                right: 4,
                top: "50%",
                transform: "translateY(-50%)",
                padding: 6,
                color: "var(--text-dim)",
              }}
              title="Clear"
            >
              <CloseIcon size={16} />
            </button>
          )}
        </div>
        <button onClick={onSubmit}>Search</button>
      </div>

      {state.kind === "searching" && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="status-pulse-live" />
          <p className="hint" style={{ margin: 0 }}>Searching across local and remote indexes…</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 10 }}>{state.message}</p>
          <button onClick={onSubmit}>Retry</button>
        </div>
      )}

      {state.kind === "results" && (
        <>
          {state.fallback && (
            <p className="hint setup-note" style={{ color: "var(--warning)" }}>
              Meaning-based search isn't available on this device — showing text matches.
            </p>
          )}
          {state.serverSkipped && (
            <div className="card panel-danger" style={{ marginBottom: 12, padding: "10px 14px" }}>
              <p className="status-error" style={{ fontSize: 13, margin: 0 }}>
                Home PC offline — showing device results only.
              </p>
            </div>
          )}

          {state.hits.length > 0 && (
            <div className="segmented-control">
              <button
                type="button"
                className={`segmented-btn ${sortMode === "hybrid" ? "active" : ""}`}
                onClick={() => handleSortChange("hybrid")}
              >
                Recency & Relevance
              </button>
              <button
                type="button"
                className={`segmented-btn ${sortMode === "recency" ? "active" : ""}`}
                onClick={() => handleSortChange("recency")}
              >
                Newest First
              </button>
              <button
                type="button"
                className={`segmented-btn ${sortMode === "relevance" ? "active" : ""}`}
                onClick={() => handleSortChange("relevance")}
              >
                Best Match
              </button>
            </div>
          )}

          {state.hits.length === 0 && (
            <div className="card" style={{ textAlign: "center", padding: "28px 16px" }}>
              <p className="hint" style={{ margin: 0 }}>
                Nothing matched. Captures are indexed as they're triaged — that happens when you reopen the app.
              </p>
            </div>
          )}

          <ul>
            {state.hits.map((h, i) => {
              const isExpanded = expanded === i;
              return (
                <li
                  key={i}
                  className="card clickable"
                  onClick={() => setExpanded(isExpanded ? null : i)}
                >
                  <div className="card-row">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={`badge ${h.source === "local" ? "primary" : "success"}`}>
                        {h.source === "local" ? "On this device" : "From home PC"}
                      </span>
                      {h.app_label && <span className="badge">{h.app_label}</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="card-meta">{formatHitTime(h.timestamp)}</span>
                      {isExpanded ? (
                        <ChevronDownIcon size={14} style={{ color: "var(--text-dim)" }} />
                      ) : (
                        <ChevronRightIcon size={14} style={{ color: "var(--text-dim)" }} />
                      )}
                    </div>
                  </div>
                  <div className={isExpanded ? "card-body" : "card-body truncated"}>
                    {h.text}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
