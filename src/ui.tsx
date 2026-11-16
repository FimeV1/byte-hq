import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

/** A button with a floating menu. The menu closes on outside click, Escape, or when `close()` is called. */
export function Popover({
  trigger, children, side = "up", align = "right", className,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  side?: "up" | "down";
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Fixed position from the trigger's place on screen, so a menu inside a scrolling list
  // (the sidebar) is not clipped by it.
  const place = (): React.CSSProperties => {
    const r = ref.current!.getBoundingClientRect();
    return {
      ...(side === "up" ? { bottom: window.innerHeight - r.top + 8 } : { top: r.bottom + 6 }),
      ...(align === "right" ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
    };
  };
  // Keep the whole menu on screen: anchored to its button it ran off a phone's edge (the sidebar's chat menu, 2026-11-16).
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.width, window.innerWidth - 16);
    if (r.right > window.innerWidth - 8 || r.left < 8) {
      el.style.right = "auto";
      el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w)) + "px";
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={"pop-wrap " + (className || "")} ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className="pop" ref={popRef} style={{ ...place(), maxWidth: "calc(100vw - 16px)" }}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <span>{title}</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Text field that replaces a label while renaming. Enter saves, Escape or blur cancels/saves. */
export function RenameInput({ value, onDone }: { value: string; onDone: (next: string | null) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const commit = () => onDone(v.trim() && v.trim() !== value ? v.trim() : null);
  return (
    <input
      ref={ref}
      className="sb-rename"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/** HQ's mark: two bars joined at a hub (several machines, one place). Also in public/favicon.svg and the app icons. */
export function Brand({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand">
      <defs>
        <linearGradient id="hq-brand" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b7bff" />
          <stop offset="1" stopColor="#5541e0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#hq-brand)" />
      <path d="M10.5 9.5v13M21.5 9.5v13M10.5 16h11" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="3.4" fill="#fff" />
    </svg>
  );
}

// ---- theme --------------------------------------------------------------------------------------
export type Theme = "system" | "light" | "dark";
export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem("hq.theme");
    return t === "light" || t === "system" ? t : "dark";
  } catch {
    return "dark";
  }
}
/** Applies a theme to <html> (styles.css switches on data-theme) and the browser/phone status bar colour. */
export function applyTheme(t: Theme = savedTheme()) {
  const root = document.documentElement;
  if (t === "dark") delete root.dataset.theme; // dark is the stylesheet's default
  else root.dataset.theme = t;
  try {
    if (t === "dark") localStorage.removeItem("hq.theme");
    else localStorage.setItem("hq.theme", t);
  } catch {}
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg || "#0f1115");
}
