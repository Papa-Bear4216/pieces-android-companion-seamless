import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  getWorkstreamSummaries,
  getCachedWorkstreamSummaries,
  ProxyNotConfiguredError,
  HomeNodeUnreachableError,
  type WorkstreamSummary,
} from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { RecentIcon, RefreshIcon, ChevronDownIcon, ChevronRightIcon, AlertIcon } from "../components/Icons";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; summaries: WorkstreamSummary[] }
  | { kind: "not-configured" }
  | { kind: "home-offline"; message: string; stale?: { summaries: WorkstreamSummary[]; at: string } }
  | { kind: "error"; message: string };

export default function Recent() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setState({ kind: "loading" });
    try {
      const summaries = await getWorkstreamSummaries();
      setState({ kind: "loaded", summaries });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setState({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        const cached = await getCachedWorkstreamSummaries();
        setState({
          kind: "home-offline",
          message: err.message,
          stale: cached ? { summaries: cached.value, at: cached.at } : undefined,
        });
      } else {
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  useEffect(() => {
    load();
    recordEvent({ type: "screen_view", screen: "recent", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-top">
          <h1>What Got Done</h1>
          <button className="secondary pill" onClick={load} title="Refresh summaries">
            <RefreshIcon size={14} /> Refresh
          </button>
        </div>
        <p className="hint">PiecesOS AI workstream rollups — summarizing your coding sessions and projects.</p>
      </div>

      {state.kind === "loading" && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="status-pulse-live" />
          <p className="hint" style={{ margin: 0 }}>Syncing workstream rollups from PiecesOS…</p>
        </div>
      )}

      {state.kind === "not-configured" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 12 }}>Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Go to Setup</button>
        </div>
      )}

      {state.kind === "home-offline" && (
        <div className="card panel-danger">
          <div className="card-row" style={{ marginBottom: 6 }}>
            <span className="status-error">Home PC is offline or unreachable</span>
            <AlertIcon size={16} color="var(--error)" />
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>{state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start", marginBottom: 12 }}>Retry</button>

          {state.stale && (
            <div>
              <p className="hint setup-note" style={{ margin: "8px 0" }}>
                Showing the last synced copy from {new Date(state.stale.at).toLocaleString()}:
              </p>
              <ul>
                {state.stale.summaries.map((s) => (
                  <li key={s.id} className="card faded">
                    <div className="card-row">
                      <span className="card-title">{s.name}</span>
                      <span className="badge">{s.created}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {state.kind === "error" && (
        <div className="card panel-danger">
          <p className="status-error" style={{ marginBottom: 12 }}>{state.message}</p>
          <button onClick={load} style={{ alignSelf: "flex-start" }}>Retry</button>
        </div>
      )}

      {state.kind === "loaded" && (
        <>
          {state.summaries.length === 0 && (
            <div className="card" style={{ textAlign: "center", padding: "32px 16px" }}>
              <RecentIcon size={32} style={{ color: "var(--text-dim)", margin: "0 auto 10px" }} />
              <p className="hint" style={{ margin: 0 }}>No workflow summaries recorded yet.</p>
            </div>
          )}

          <ul>
            {state.summaries.map((s) => {
              const isExpanded = expanded === s.id;
              return (
                <li
                  key={s.id}
                  className="card clickable"
                  onClick={() => setExpanded(isExpanded ? null : s.id)}
                >
                  <div className="card-row">
                    <span className="card-title">{s.name}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="badge">{s.created}</span>
                      {isExpanded ? (
                        <ChevronDownIcon size={14} style={{ color: "var(--text-dim)" }} />
                      ) : (
                        <ChevronRightIcon size={14} style={{ color: "var(--text-dim)" }} />
                      )}
                    </div>
                  </div>
                  {isExpanded && <div className="card-body">{s.text}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
