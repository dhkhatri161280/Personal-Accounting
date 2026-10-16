"use client";
import { useEffect, useRef, useState } from "react";
import type { Ledger } from "@/lib/vault-types";
import { TOOL_DEFS, executeTool, coerceToolArgs } from "@/lib/assistant-tools";
import { apiFetch } from "@/lib/api-fetch";
import { todayLocalIso } from "@/lib/format-date";

// toolTrace (assistant messages only) is the exact tool call(s) that produced this answer --
// confirmed live this is genuinely needed: asked "how much is the ESPP this FY", the assistant
// gave a number matching nothing in the real ledger report, and there was no way to tell whether
// it had called the precise get_account_ledger tool or the broader search_vouchers tool (which can
// pull in an unrelated account that merely shares a word in its name) without guessing. Shown as a
// small caption under the reply so a wrong-looking answer is immediately diagnosable instead of a
// guess every time.
type ChatMessage = { role: "user" | "assistant"; content: string; toolTrace?: string[] };
// The API-side conversation (what actually goes to app/api/assistant) also carries "tool" turns --
// a tool call's JSON (as an assistant message) and its result (as a tool message) -- which the chat
// UI never shows directly (see ChatMessage above, which is just user/assistant for display).
type ApiMessage = { role: "user" | "assistant" | "tool"; content: string };
// A free, small model asking for the same tool over and over (or never settling on a final answer)
// is a real failure mode to cap, not just a hypothetical -- 6 rounds is enough for any legitimate
// multi-tool question this assistant's tool set supports.
const MAX_TOOL_ROUNDS = 6;
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
// the weight of any screen that isn't actively using it. Tool-calling (see lib/assistant-tools.ts
// and the send() loop below), not a text snapshot -- this component is the only place that reads
// the decrypted Ledger for this feature, executing each tool call the model asks for locally; the
// server route never sees real data, only the tool name/arguments and the computed result.
//
// Both the closed bubble (drag anywhere) and the open panel (drag its header to move, corners to
// resize) are fully user-positionable, each remembered independently in localStorage -- confirmed
// live that no single fixed position/size avoids covering real content or other fixed-position UI
// (the install-options PWA buttons, a Day Book's own scrollbar) on every screen; letting the user
// park each piece wherever actually works for whatever they're looking at is what generalizes.
// Deliberately NOT built on FloatingWindow (used elsewhere for drilldowns): that component has no
// drag-to-move at all (only corner-resize), and its full-page dimming overlay is a modal pattern
// wrong for a widget meant to stay open alongside normal use, not block it.
// nvdaPrice/nvdaPrevClose: VaultApp's own already-fetched live quote (for its Equity dashboard
// card), passed down so get_equity_position/get_net_worth can use the SAME live price the
// dashboard itself shows, instead of this component fetching (and potentially getting a
// slightly different) quote a second time.
export function ChatAssistant({ data, book, nvdaPrice = null, nvdaPrevClose = null }: { data: Ledger; book: "us" | "india"; nvdaPrice?: number | null; nvdaPrevClose?: number | null }) {
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

  // Tool-calling loop (see lib/assistant-tools.ts for why phase 1's context-stuffing approach was
  // replaced). The model picks a tool + arguments; executeTool runs it HERE, client-side, against
  // the decrypted Ledger already in memory (the server route never sees real data, only the tool
  // name/arguments the model chose and the already-computed result this loop sends back) -- same
  // vault-blind posture app/api/assistant always had. Loops until the model returns a final text
  // reply instead of another tool call, capped at MAX_TOOL_ROUNDS so a model that never settles
  // can't hang the UI forever.
  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setError(null);
    const nextMessages: ChatMessage[] = [...messages, { role: "user", content: message }];
    setMessages(nextMessages);
    setSending(true);
    try {
      const priorHistory: ApiMessage[] = nextMessages.slice(0, -1).slice(-MAX_HISTORY_SENT);
      const apiMessages: ApiMessage[] = [...priorHistory, { role: "user", content: message }];
      const tools = TOOL_DEFS.filter((t) => book === "india" || t.name !== "get_fbar_status");
      const todayIso = todayLocalIso();
      const toolTrace: string[] = [];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const r = await apiFetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: apiMessages, tools }),
        });
        const j = (await r.json().catch(() => null)) as { reply?: string; toolCalls?: { name: string; arguments: unknown }[]; error?: string } | null;
        if (!r.ok || !j) {
          setError(j?.error || `Request failed (${r.status})`);
          return;
        }
        if (j.toolCalls?.length) {
          for (const call of j.toolCalls) {
            // Defensive: Workers AI's own docs show `arguments` as an already-parsed object, but
            // other providers' function-calling APIs serialize it as a JSON STRING instead -- cheap
            // insurance against that difference (or any other malformed shape) rather than letting
            // property access on a string silently no-op every argument.
            const args = coerceToolArgs(call.arguments);
            toolTrace.push(`${call.name}(${Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})`);
            apiMessages.push({ role: "assistant", content: JSON.stringify({ name: call.name, arguments: args }) });
            // Isolated from the outer try/catch's generic "Network error" message -- a thrown error
            // HERE is a tool-execution bug, not a network failure, and the model can usefully react
            // to an explicit tool-failure message (and tell the user) instead of the whole exchange
            // dying with a misleading error.
            let result: string;
            try {
              result = executeTool(call.name, args, data, book, todayIso, nvdaPrice, nvdaPrevClose);
            } catch (e) {
              result = `Tool "${call.name}" failed: ${e instanceof Error ? e.message : String(e)}`;
            }
            apiMessages.push({ role: "tool", content: result });
          }
          continue;
        }
        if (j.reply) {
          setMessages((prev) => [...prev, { role: "assistant", content: j.reply!, toolTrace: toolTrace.length ? toolTrace : undefined }]);
          return;
        }
        setError(j.error || "Empty response from assistant.");
        return;
      }
      setError("The assistant couldn't settle on an answer after several tool lookups -- please try rephrasing.");
    } catch {
      setError("Network error -- please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      {/* Wrapping the bubble and its name label together -- rather than positioning the label at a
          hardcoded offset from the bubble's own top/left -- means the label centers under whatever
          the bubble's REAL rendered width turns out to be (left:50%/translateX(-50%) relative to
          this wrapper), instead of assuming it's exactly the CSS's nominal 52px. Confirmed live the
          hardcoded-offset version was still visibly off-center. */}
      <div
        className="chat-assistant-bubble-wrap"
        style={bubblePos ? { top: bubblePos.top, left: bubblePos.left, right: "auto", bottom: "auto" } : { visibility: "hidden" }}
      >
        <button
          type="button"
          className="chat-assistant-bubble"
          onPointerDown={bubblePointerDown}
          onClick={bubbleClick}
          aria-label={open ? "Close chat assistant" : "Open chat assistant"}
          title="DiHiTwa -- chat assistant (free, Cloudflare Workers AI) -- drag to move"
        >
          {open ? "✕" : "💬"}
        </button>
        {/* pointer-events:none so the label never steals the drag/click the bubble itself handles. */}
        <div className="chat-assistant-bubble-label">DiHiTwa</div>
      </div>
      {open && (
        <div className="chat-assistant-panel" style={rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : { visibility: "hidden" }}>
          <div className="chat-assistant-header" onPointerDown={startMove} style={{ cursor: "move" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <strong>DiHiTwa</strong>
                <span
                  style={{ fontSize: 12, opacity: 0.55, cursor: "help" }}
                  title="Free -- answers from your own data snapshot, not a tax/legal advisor"
                >
                  ⓘ
                </span>
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
                Ask about your balances, spending, salary, equity/stock position, net worth, trading gains, or
                (India book) your FBAR status. Drag the header to move this panel, or its corners to resize -- both
                are remembered next time, same as dragging the bubble itself when closed.
              </p>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chat-assistant-message chat-assistant-message--${m.role}`}
                // Confirmed live: the visible "🔧 tool(args)" caption was genuinely useful for
                // diagnosing a wrong-looking answer, but the user found it too much clutter to see
                // on every normal reply. Kept, just moved into a hover tooltip instead of always
                // rendered -- still one hover away when a number needs checking, invisible otherwise.
                title={m.toolTrace ? `Tool call(s) used: ${m.toolTrace.join(" | ")}` : undefined}
              >
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
