import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from "lucide-react";

type Tab = { id: string; title: string; url: string };
type Frame = { data: string; w: number; h: number };

function act(body: Record<string, unknown>) {
  return fetch("/hq/browser/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json())
    .catch(() => null);
}

// Clicks and keys must reach the page in the order they happened, so they go one at a time.
// Mouse moves are dropped while others are waiting: only the latest position matters.
let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;
function input(body: Record<string, unknown>) {
  if (body.type === "mouseMoved" && waiting > 0) return;
  waiting++;
  chain = chain.then(() => act(body)).finally(() => waiting--);
}

// CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const SPECIAL: Record<string, number> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

export function BrowserPane({ followAgent }: { followAgent: number }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [tabId, setTabId] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [down, setDown] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const known = useRef<Set<string>>(new Set());
  const current = tabs.find((t) => t.id === tabId);

  // One stream per selected tab: tab list updates + screencast frames.
  useEffect(() => {
    const es = new EventSource("/hq/browser/stream" + (tabId ? `?tab=${tabId}` : ""));
    es.addEventListener("tabs", (m) => {
      const list: Tab[] = JSON.parse((m as MessageEvent).data);
      setTabs(list);
      // Follow the newest tab (that is where the agent just opened a page), or recover from a closed one.
      const first = known.current.size === 0;
      const fresh = first ? undefined : list.find((t) => !known.current.has(t.id));
      list.forEach((t) => known.current.add(t.id));
      setTabId((cur) => {
        if (fresh) return fresh.id;
        if (!cur || !list.some((t) => t.id === cur)) return list[0]?.id ?? null;
        return cur;
      });
    });
    es.addEventListener("frame", (m) => setFrame(JSON.parse((m as MessageEvent).data)));
    return () => es.close();
  }, [tabId]);

  // The agent used a browser tool: jump to its most recent tab.
  useEffect(() => {
    if (followAgent && tabs[0]) setTabId(tabs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followAgent]);

  // Keep the page's viewport the size of the pane (debounced while dragging/resizing).
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = view.current;
    if (!el || !tabId) return;
    let t: number | undefined;
    const send = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 50 && height > 50) act({ tab: tabId, action: "resize", width, height, scale: window.devicePixelRatio || 1 });
    };
    const ro = new ResizeObserver(() => (window.clearTimeout(t), (t = window.setTimeout(send, 150))));
    ro.observe(el);
    return () => (ro.disconnect(), window.clearTimeout(t));
  }, [tabId]);

  useEffect(() => {
    if (!editing) setAddress(current?.url && current.url !== "about:blank" ? current.url : "");
  }, [current?.url, editing]);

  const point = useCallback(
    (e: React.MouseEvent | React.WheelEvent) => {
      const r = img.current!.getBoundingClientRect();
      const f = frame || { w: 1280, h: 800 };
      // The image is drawn "contain" from the top-left corner: scale by the drawn size, not the box.
      const k = Math.min(r.width / f.w, r.height / f.h);
      return { x: Math.round((e.clientX - r.left) / k), y: Math.round((e.clientY - r.top) / k) };
    },
    [frame],
  );
  const lastMove = useRef(0);
  // Finger drags on a phone scroll the page (sent as wheel steps). Taps still arrive as mouse clicks.
  const touch = useRef<{ x: number; y: number; t: number; moved: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const p = e.touches[0];
    touch.current = { x: p.clientX, y: p.clientY, t: 0, moved: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s || !tabId || !img.current) return;
    const p = e.touches[0];
    const dx = s.x - p.clientX;
    const dy = s.y - p.clientY;
    if (!s.moved && Math.abs(dx) < 6 && Math.abs(dy) < 6) return; // still a tap
    s.moved = true;
    const now = performance.now();
    if (now - s.t < 40) return;
    const r = img.current.getBoundingClientRect();
    const f = frame || { w: 1280, h: 800 };
    const k = Math.min(r.width / f.w, r.height / f.h);
    input({ tab: tabId, action: "wheel", ...point(e.touches[0] as unknown as React.MouseEvent), deltaX: Math.round(dx / k), deltaY: Math.round(dy / k) });
    Object.assign(s, { x: p.clientX, y: p.clientY, t: now });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!tabId) return;
    if (e.metaKey && (e.key === "v" || e.key === "c")) return; // let the browser handle copy/paste (paste handled below)
    e.preventDefault();
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) input({ tab: tabId, action: "text", text: e.key });
    else if (SPECIAL[e.key] !== undefined)
      input({ tab: tabId, action: "key", key: e.key, code: e.code, keyCode: SPECIAL[e.key], modifiers: mods(e), ...(e.key === "Enter" ? { text: "\r" } : {}) });
    else if (e.key.length === 1)
      input({ tab: tabId, action: "key", key: e.key, code: e.code, keyCode: e.key.toUpperCase().charCodeAt(0), modifiers: mods(e) });
  };

  return (
    <div className="bp">
      {tabs.length > 1 && (
        <div className="bp-tabs">
          {tabs.map((t) => (
            <div key={t.id} className={"bp-tab" + (t.id === tabId ? " on" : "")} onClick={() => setTabId(t.id)} title={t.url}>
              <Globe size={12} />
              <span>{t.title || t.url || "New tab"}</span>
              <button type="button" onClick={(e) => (e.stopPropagation(), act({ tab: t.id, action: "closeTab" }))} aria-label="Close tab"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="bp-bar">
        <button type="button" className="icon-btn" onClick={() => act({ tab: tabId, action: "back" })} aria-label="Back" title="Back"><ArrowLeft size={17} /></button>
        <button type="button" className="icon-btn" onClick={() => act({ tab: tabId, action: "forward" })} aria-label="Forward" title="Forward"><ArrowRight size={17} /></button>
        <button type="button" className="icon-btn" onClick={() => act({ tab: tabId, action: "reload" })} aria-label="Reload" title="Reload"><RotateCw size={16} /></button>
        <form
          className="bp-url"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            if (address.trim()) act({ tab: tabId, action: "navigate", url: address });
            (document.activeElement as HTMLElement)?.blur();
          }}
        >
          <Globe size={14} />
          <input value={address} placeholder="Search or enter address" onFocus={(e) => (setEditing(true), e.target.select())} onBlur={() => setEditing(false)} onChange={(e) => setAddress(e.target.value)} />
        </form>
        <button type="button" className="icon-btn" onClick={() => act({ action: "newTab" }).then((t) => t?.result?.id && setTabId(t.result.id))} aria-label="New tab" title="New tab"><Plus size={17} /></button>
      </div>
      <div
        ref={view}
        className="bp-view"
        tabIndex={0}
        onKeyDown={onKey}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (text && tabId) (e.preventDefault(), input({ tab: tabId, action: "text", text }));
        }}
      >
        {frame ? (
          <img
            ref={img}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={current?.title || "Browser"}
            draggable={false}
            onMouseDown={(e) => {
              (e.currentTarget.parentElement as HTMLElement).focus();
              setDown(true);
              input({ tab: tabId, action: "mouse", type: "mousePressed", ...point(e), clickCount: e.detail || 1 });
            }}
            onMouseUp={(e) => (setDown(false), input({ tab: tabId, action: "mouse", type: "mouseReleased", ...point(e), clickCount: e.detail || 1 }))}
            onMouseMove={(e) => {
              const now = performance.now();
              if (now - lastMove.current < (down ? 30 : 120)) return; // hover needs fewer updates than a drag
              lastMove.current = now;
              input({ tab: tabId, action: "mouse", type: "mouseMoved", ...point(e), buttons: down ? 1 : 0 });
            }}
            onWheel={(e) => input({ tab: tabId, action: "wheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={() => (touch.current = null)}
          />
        ) : (
          <div className="bp-empty">{tabs.length ? "Loading…" : "Starting the browser…"}</div>
        )}
        {frame && (!current?.url || current.url === "about:blank") && <div className="bp-hint">Type an address or a search above</div>}
      </div>
    </div>
  );
}
