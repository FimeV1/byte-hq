import { memo, useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || "").trim().split(/\s+/)[0];
      let html: string;
      try {
        html = language && hljs.getLanguage(language) ? hljs.highlight(text, { language }).value : esc(text);
      } catch {
        html = esc(text);
      }
      return `<div class="code"><div class="code-head"><span>${esc(language || "text")}</span><button type="button" data-copy>Copy</button></div><pre><code>${html}</code></pre></div>`;
    },
  },
});

// Model output is untrusted: sanitise it, and make links open outside the app.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || "";
    if (/^https?:/i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else {
      node.setAttribute("data-file", href);
      node.removeAttribute("href");
    }
  }
});

function onClick(e: React.MouseEvent<HTMLDivElement>) {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
  if (!btn) return;
  const code = btn.closest(".code")?.querySelector("code")?.textContent || "";
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  });
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className={"md " + (className || "")} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
