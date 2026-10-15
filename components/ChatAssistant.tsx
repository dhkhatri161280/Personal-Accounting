"use client";
import { useEffect, useRef, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { buildAssistantContext } from "@/lib/assistant-context";
import { apiFetch } from "@/lib/api-fetch";

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_HISTORY_SENT = 12;

// Free in-app chat assistant -- Cloudflare Workers AI (app/api/assistant), not the Anthropic API.
// A fixed corner bubble (not a new header icon or a bigger existing screen) so it adds nothing to
// the weight of any screen that isn't actively using it -- same reasoning that moved the FBAR
// filer profile out of Settings earlier. Sends a computed summary of the user's own data (see
// lib/assistant-context.ts) with every question -- this component is the only place that reads
// the decrypted Ledger for this feature; the server route never sees it.
export function ChatAssistant({ data, book }: { data: Ledger; book: "us" | "india" }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: message }];
    setMessages(nextMessages);
    setSending(true);
    try {
      const context = buildAssistantContext(data, book);
      const r = await apiFetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, context, history: nextMessages.slice(0, -1).slice(-MAX_HISTORY_SENT) }),
      });
      const j = (await r.json().catch(() => null)) as { reply?: string; error?: string } | null;
      if (!r.ok || !j?.reply) {
        setError(j?.error || `Request failed (${r.status})`);
        return;
      }
      setMessages((prev) => [...prev, { role: "assistant", content: j.reply! }]);
    } catch {
      setError("Network error -- please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="chat-assistant-bubble"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close chat assistant" : "Open chat assistant"}
        title="Chat assistant (free, Cloudflare Workers AI)"
      >
        {open ? "✕" : "💬"}
      </button>
      {open && (
        <div className="chat-assistant-panel">
          <div className="chat-assistant-header">
            <strong>Assistant</strong>
            <span style={{ fontSize: 11, opacity: 0.6 }}>Free -- answers from your own data snapshot, not a tax/legal advisor</span>
          </div>
          <div className="chat-assistant-messages" ref={listRef}>
            {messages.length === 0 && (
              <p style={{ opacity: 0.6, fontSize: 13 }}>
                Ask about your balances, this month's spend, or (India book) your FBAR status.
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`chat-assistant-message chat-assistant-message--${m.role}`}>
                {m.content}
              </div>
            ))}
            {sending && <div className="chat-assistant-message chat-assistant-message--assistant">…</div>}
          </div>
          {error && (
            <p style={{ margin: "0 10px 8px", fontSize: 12, color: "#991b1b" }}>{error}</p>
          )}
          <div className="chat-assistant-input-row">
            <input
              type="text"
              value={input}
              placeholder="Ask a question…"
              disabled={sending}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            />
            <button type="button" className="primary" disabled={sending || !input.trim()} onClick={send}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
