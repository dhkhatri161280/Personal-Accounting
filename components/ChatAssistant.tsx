"use client";
import { useEffect, useRef, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { buildAssistantContext, extractSearchTerms, searchVouchersAcrossAllDates } from "@/lib/assistant-context";
import { apiFetch } from "@/lib/api-fetch";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Rect = { top: number; left: number; width: number; height: number };
type Point = { top: number; left: number };
type Corner = "nw" | "ne" | "sw" | "se";

const MAX_HISTORY_SENT = 12;
const MIN_W = 280;
const MIN_H = 220;
const BUBBLE_SIZE = 52;
const CORNERS: Corner[] = ["nw", "ne", "sw", "se"];
const RECT_STORAGE_KEY = "dk-chat-assistant-rect";
const BUBBLE_STORAGE_KEY = "dk-chat-assistant-bubble-pos";
// A pointerdown->pointerup with less movement than this is treated as a click (open/close the
// panel) rather than a drag -- without this, the bubble's own onClick would never fire at all
// once it's also listening for drags, since every click technically starts and ends a 0px "drag".
const DRAG_CLICK_THRESHOLD = 4;

// Free in-app chat assistant -- Cloudflare Workers AI (app/api/assistant), not the Anthropic API.
// A fixed corner bubble (not a new header icon or a bigger existing screen) so it adds nothing to
// the weight of any screen that isn't actively using it. Sends a computed summary of the user's
// own data (see lib/assistant-context.ts) with every question -- this component is the only place
// that reads the decrypted Ledger for this feature; the server route never sees it.
//
// Both the closed bubble (drag anywhere) and the open panel (drag its header to move, corners to
// resize) are fully user-positionable, each remembered independently in localStorage -- confirmed
// live that no single fixed position/size avoids covering real content or other fixed-position UI
// (the install-options PWA buttons, a Day Book's own scrollbar) on every screen; letting the user
// park each piece wherever actually works for whatever they're looking at is what generalizes.
// Deliberately NOT built on FloatingWindow (used elsewhere for drilldowns): that component has no
// drag-to-move at all (only corner-resize), and its full-page dimming overlay is a modal pattern
// wrong for a widget meant to stay open alongside normal use, not block it.
export function ChatAssistant({ data, book }: { data: Ledger; book: "us" | "india" }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [bubblePos, setBubblePos] = useState<Point | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ kind: "move"; startX: number; startY: number; rect: Rect } | { kind: "resize"; corner: Corner; startX: number; startY: number; rect: Rect } | null>(null);
  const bubbleDragRef = useRef<{ startX: number; startY: number; pos: Point; moved: boolean } | null>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  // .install-options (the PWA install buttons, see PWARegister.tsx) shares this same bottom-right
  // corner, and its own height varies wildly across breakpoints -- confirmed live it has dozens
  // of responsive overrides. Measures the real element's actual position instead of guessing a
  // static offset, and stays correct if its size or presence changes (resize, orientation change,
  // or it disappearing post-install). Only feeds the bubble's own DEFAULT position (first run, or
  // if localStorage has nothing usable) -- once the user drags it, their position wins instead.
  useEffect(() => {
    function updateOffset() {
      const el = document.querySelector<HTMLElement>(".install-options");
      let offset = 20;
      if (el) {
        const r = el.getBoundingClientRect();
        const visible = r.height > 0 && getComputedStyle(el).display !== "none";
        if (visible) offset = window.innerHeight - r.top + 12;
      }
      document.documentElement.style.setProperty("--chat-bubble-offset", `${offset}px`);
    }
    updateOffset();
    window.addEventListener("resize", updateOffset);
    const resizeObserver = new ResizeObserver(updateOffset);
    const target = document.querySelector(".install-options");
    if (target) resizeObserver.observe(target);
    const mutationObserver = new MutationObserver(updateOffset);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", updateOffset);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  // Restores (or computes a first-time default for) the bubble's own position, once on mount.
  useEffect(() => {
    const vw = window.innerWidth,
      vh = window.innerHeight;
    let saved: Point | null = null;
    try {
      const raw = localStorage.getItem(BUBBLE_STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // ignore corrupt/missing storage -- fall through to the computed default below
    }
    if (saved && saved.left >= -40 && saved.top >= -40 && saved.left <= vw + 40 && saved.top <= vh + 40) {
      setBubblePos(saved);
      return;
    }
    const installClearance = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--chat-bubble-offset") || "20", 10) || 20;
    setBubblePos({ top: Math.max(12, vh - installClearance - BUBBLE_SIZE), left: Math.max(12, vw - 20 - BUBBLE_SIZE) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (bubblePos) {
      try {
        localStorage.setItem(BUBBLE_STORAGE_KEY, JSON.stringify(bubblePos));
      } catch {
        // storage full/unavailable -- losing the remembered position isn't worth surfacing an error for
      }
    }
  }, [bubblePos]);

  // Computes (or restores) the panel's rect the moment it's opened, not on mount -- window size
  // isn't meaningful to measure against before the user actually opens it, and restoring a saved
  // rect from a previous, differently-sized window could otherwise land off-screen.
  useEffect(() => {
    if (!open || rect) return;
    const vw = window.innerWidth,
      vh = window.innerHeight;
    let saved: Rect | null = null;
    try {
      const raw = localStorage.getItem(RECT_STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {
      // ignore corrupt/missing storage -- fall through to the computed default below
    }
    if (saved && saved.left + saved.width <= vw + 40 && saved.top + saved.height <= vh + 40 && saved.left >= -40 && saved.top >= -40) {
      setRect(saved);
      return;
    }
    // Default: wide-and-short on a landscape desktop (more likely to clear content sitting above
    // it), narrower-and-taller on a portrait/mobile screen -- a starting point, not a final
    // answer, since the user can now drag/resize it anywhere that works for their actual screen.
    const landscape = vw >= 900 && vw >= vh;
    const width = Math.min(landscape ? 620 : 340, vw - 32);
    const height = Math.min(landscape ? 320 : 440, vh - 32);
    const bubbleTop = bubblePos?.top ?? vh - 80;
    const top = Math.max(12, bubbleTop - 12 - height);
    const left = Math.max(12, Math.min((bubblePos?.left ?? vw - 72) - (width - BUBBLE_SIZE), vw - width - 12));
    setRect({ top, left, width, height });
  }, [open, rect, bubblePos]);

  useEffect(() => {
    if (rect) {
      try {
        localStorage.setItem(RECT_STORAGE_KEY, JSON.stringify(rect));
      } catch {
        // storage full/unavailable -- losing the remembered position isn't worth surfacing an error for
      }
    }
  }, [rect]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const bd = bubbleDragRef.current;
      if (bd) {
        const dx = e.clientX - bd.startX,
          dy = e.clientY - bd.startY;
        if (Math.abs(dx) > DRAG_CLICK_THRESHOLD || Math.abs(dy) > DRAG_CLICK_THRESHOLD) bd.moved = true;
        if (bd.moved) {
          const vw = window.innerWidth,
            vh = window.innerHeight;
          const left = Math.max(0, Math.min(bd.pos.left + dx, vw - BUBBLE_SIZE));
          const top = Math.max(0, Math.min(bd.pos.top + dy, vh - BUBBLE_SIZE));
          setBubblePos({ top, left });
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX,
        dy = e.clientY - d.startY;
      if (d.kind === "move") {
        const vw = window.innerWidth,
          vh = window.innerHeight;
        const left = Math.max(0, Math.min(d.rect.left + dx, vw - d.rect.width));
        const top = Math.max(0, Math.min(d.rect.top + dy, vh - d.rect.height));
        setRect({ ...d.rect, top, left });
        return;
      }
      let { top, left, width, height } = d.rect;
      if (d.corner.includes("e")) width = Math.max(MIN_W, Math.min(d.rect.width + dx, window.innerWidth - left - 12));
      if (d.corner.includes("s")) height = Math.max(MIN_H, Math.min(d.rect.height + dy, window.innerHeight - top - 12));
      if (d.corner.includes("w")) {
        width = Math.max(MIN_W, d.rect.width - dx);
        left = d.rect.left + (d.rect.width - width);
      }
      if (d.corner.includes("n")) {
        height = Math.max(MIN_H, d.rect.height - dy);
        top = d.rect.top + (d.rect.height - height);
      }
      setRect({ top, left, width, height });
    }
    function onUp() {
      dragRef.current = null;
      // bubbleDragRef is cleared by the bubble's own onClick/onPointerUp handler (see below) --
      // it needs to read `moved` one more time there to decide whether to toggle `open`.
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startMove(e: React.PointerEvent) {
    if (!rect || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    dragRef.current = { kind: "move", startX: e.clientX, startY: e.clientY, rect };
  }

  function startResize(corner: Corner) {
    return (e: React.PointerEvent) => {
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { kind: "resize", corner, startX: e.clientX, startY: e.clientY, rect };
    };
  }

  function bubblePointerDown(e: React.PointerEvent) {
    if (!bubblePos) return;
    bubbleDragRef.current = { startX: e.clientX, startY: e.clientY, pos: bubblePos, moved: false };
  }

  function bubbleClick() {
    // A real drag (moved past the threshold) must not also toggle the panel open/closed -- only
    // a plain click (no meaningful movement) does that.
    if (bubbleDragRef.current?.moved) {
      bubbleDragRef.current = null;
      return;
    }
    bubbleDragRef.current = null;
    setOpen((v) => !v);
  }

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: message }];
    setMessages(nextMessages);
    setSending(true);
    try {
      const baseContext = buildAssistantContext(data, book);
      // Confirmed live: asked "this fiscal year" questions, the assistant could only ever
      // honestly say "I only have this month's data" -- accurate, but useless for what was
      // actually asked. baseContext stays month-scoped (dumping every voucher ever posted would
      // blow both the char budget and the free model's context window), but THIS message's own
      // wording (e.g. "Costco", "Gasoline") drives a real full-history search appended just for
      // this turn -- see searchVouchersAcrossAllDates's own comment.
      const searchTerms = extractSearchTerms(message, data);
      const searchResults = searchTerms.length ? searchVouchersAcrossAllDates(data, searchTerms) : "";
      const context = searchResults ? `${baseContext}\n\n${searchResults}` : baseContext;
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
        style={bubblePos ? { top: bubblePos.top, left: bubblePos.left, right: "auto", bottom: "auto" } : { visibility: "hidden" }}
        onPointerDown={bubblePointerDown}
        onClick={bubbleClick}
        aria-label={open ? "Close chat assistant" : "Open chat assistant"}
        title="Chat assistant (free, Cloudflare Workers AI) -- drag to move"
      >
        {open ? "✕" : "💬"}
      </button>
      {open && (
        <div className="chat-assistant-panel" style={rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : { visibility: "hidden" }}>
          <div className="chat-assistant-header" onPointerDown={startMove} style={{ cursor: "move" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div>
                <strong>Assistant</strong>
                <div style={{ fontSize: 11, opacity: 0.6 }}>Free -- answers from your own data snapshot, not a tax/legal advisor</div>
              </div>
              {/* Confirmed live: the only close control was the floating bubble, which can end up
                  far from the panel once both are dragged independently -- the panel header has
                  its own close button now too, so closing doesn't mean hunting for the bubble. */}
              <button type="button" className="chat-assistant-close-btn" onClick={() => setOpen(false)} aria-label="Close chat assistant" title="Close">
                ✕
              </button>
            </div>
          </div>
          <div className="chat-assistant-messages" ref={listRef}>
            {messages.length === 0 && (
              <p style={{ opacity: 0.6, fontSize: 13 }}>
                Ask about your balances, this month's spend, or (India book) your FBAR status. Drag the header to move
                this panel, or its corners to resize -- both are remembered next time, same as dragging the bubble
                itself when closed.
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
          {CORNERS.map((c) => (
            <div key={c} className={`fw-handle fw-handle-${c}`} onPointerDown={startResize(c)} />
          ))}
        </div>
      )}
    </>
  );
}
