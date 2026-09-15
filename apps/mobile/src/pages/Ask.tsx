import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router";
import { ask, ProxyNotConfiguredError, HomeNodeUnreachableError } from "../lib/api";
import { recordEvent } from "../lib/usage";
import { flushUsageEvents } from "../lib/flush";
import { SparklesIcon, SendIcon, BotIcon, UserIcon, CopyIcon, CheckIcon, AlertIcon } from "../components/Icons";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  raw?: unknown;
  timestamp: string;
}

const SUGGESTIONS = [
  "What have I been working on today?",
  "Summarize my recent activity",
  "What apps have I used most frequently?",
  "What code or files was I editing recently?",
];

function formatAnswerContent(answers: unknown): string {
  if (typeof answers === "string") return answers;
  if (!answers) return "No answer returned.";
  if (typeof answers === "object") {
    const obj = answers as any;
    if (obj.text && typeof obj.text === "string") return obj.text;
    if (obj.answer && typeof obj.answer === "string") return obj.answer;
    if (obj.summary && typeof obj.summary === "string") return obj.summary;
    if (Array.isArray(answers)) {
      return answers
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item, null, 2)))
        .join("\n\n");
    }
    return JSON.stringify(answers, null, 2);
  }
  return String(answers);
}

export default function Ask() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<{ kind: "not-configured" | "home-offline" | "error" | "unavailable"; message?: string; likelyNoModelConfigured?: boolean } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    recordEvent({ type: "screen_view", screen: "ask", timestamp: new Date().toISOString() });
    flushUsageEvents();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function handleAsk(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    setErrorBanner(null);
    setQuery("");
    const userMsgId = Date.now().toString();
    const userMsg: Message = {
      id: userMsgId,
      role: "user",
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const result = await ask(trimmed);
      if (result.status === "unavailable") {
        setErrorBanner({
          kind: "unavailable",
          message: result.reason,
          likelyNoModelConfigured: result.likelyNoModelConfigured,
        });
      } else if (result.status === "answered") {
        const formatted = formatAnswerContent(result.answers);
        const assistantMsg: Message = {
          id: (Date.now() + 1).toString(),
          role: "assistant",
          content: formatted,
          raw: result.answers,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }

      recordEvent({
        type: "ask",
        screen: "ask",
        query: trimmed,
        result: result.status,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ProxyNotConfiguredError) {
        setErrorBanner({ kind: "not-configured" });
      } else if (err instanceof HomeNodeUnreachableError) {
        setErrorBanner({ kind: "home-offline", message: err.message });
        recordEvent({ type: "ask", screen: "ask", query: trimmed, result: "error", timestamp: new Date().toISOString() });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setErrorBanner({ kind: "error", message: msg });
        recordEvent({ type: "ask", screen: "ask", query: trimmed, result: "error", timestamp: new Date().toISOString() });
      }
    } finally {
      setLoading(false);
      flushUsageEvents();
    }
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (e) {
      console.error("Clipboard copy failed", e);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-header-top">
          <h1>Ask Copilot</h1>
          <span className="badge primary">
            <SparklesIcon size={12} /> Pieces AI
          </span>
        </div>
        <p className="hint">Ask anything about your past work, captures, and system context.</p>
      </div>

      {errorBanner?.kind === "not-configured" && (
        <div className="card panel-danger" style={{ marginBottom: 14 }}>
          <p className="status-error" style={{ marginBottom: 10 }}>Not set up yet.</p>
          <button onClick={() => navigate("/setup")}>Go to Setup</button>
        </div>
      )}

      {errorBanner?.kind === "home-offline" && (
        <div className="card panel-danger" style={{ marginBottom: 14 }}>
          <p className="status-error">Home PC is offline or unreachable. {errorBanner.message}</p>
        </div>
      )}

      {errorBanner?.kind === "error" && (
        <div className="card panel-danger" style={{ marginBottom: 14 }}>
          <p className="status-error">{errorBanner.message}</p>
        </div>
      )}

      {errorBanner?.kind === "unavailable" && (
        <div className="card panel-danger" style={{ marginBottom: 14 }}>
          <div className="card-row" style={{ marginBottom: 6 }}>
            <span className="status-error">Ask is currently unavailable</span>
            <AlertIcon size={16} color="var(--error)" />
          </div>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 8px" }}>{errorBanner.message}</p>
          {errorBanner.likelyNoModelConfigured && (
            <p className="hint" style={{ fontSize: 12, margin: 0 }}>
              On your PC running PiecesOS: open the Pieces desktop app → Settings → Models/Copilot,
              and enable a local model or connect a cloud provider (OpenAI, Anthropic, Gemini).
            </p>
          )}
        </div>
      )}

      <div className="chat-container">
        {messages.length === 0 && (
          <div>
            <p className="hint" style={{ fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              Suggested questions:
            </p>
            <div className="suggestions-grid">
              {SUGGESTIONS.map((item, idx) => (
                <div
                  key={idx}
                  className="suggestion-chip"
                  onClick={() => handleAsk(item)}
                >
                  <span>{item}</span>
                  <SendIcon size={14} style={{ opacity: 0.6 }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`chat-bubble ${m.role}`}>
            <div className="chat-avatar">
              {m.role === "user" ? <UserIcon size={18} /> : <BotIcon size={18} />}
            </div>
            <div className="chat-content">
              <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              {m.role === "assistant" && (
                <div className="chat-bubble-actions">
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{m.timestamp}</span>
                  <button
                    className="copy-btn"
                    onClick={() => copyToClipboard(m.content, m.id)}
                    title="Copy answer"
                  >
                    {copiedId === m.id ? (
                      <>
                        <CheckIcon size={12} /> Copied
                      </>
                    ) : (
                      <>
                        <CopyIcon size={12} /> Copy
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-bubble assistant">
            <div className="chat-avatar">
              <BotIcon size={18} />
            </div>
            <div className="chat-content" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="status-pulse-live" />
              <span style={{ color: "var(--text-muted)", fontSize: 13.5 }}>Copilot is thinking…</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="ask-input-bar">
        <input
          type="text"
          placeholder="Ask Copilot a question…"
          value={query}
          disabled={loading}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAsk(query)}
        />
        <button
          className="ask-send-btn"
          onClick={() => handleAsk(query)}
          disabled={loading || !query.trim()}
          title="Send"
        >
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
