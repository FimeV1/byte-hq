import { useEffect } from "react";
import { createPortal } from "react-dom";
import { donePrinting, useStore } from "./store";
import { Markdown } from "./Markdown";

/** "Print or save as PDF": the chat laid out as a document, printed through the browser (which can save it as a PDF). */
export function PrintView() {
  const printing = useStore((s) => s.printing);
  useEffect(() => {
    if (!printing) return;
    const prev = document.title;
    document.title = printing.title; // the browser suggests it as the PDF's file name
    const after = () => {
      donePrinting();
      document.title = prev;
    };
    window.addEventListener("afterprint", after, { once: true });
    const t = setTimeout(() => window.print(), 300); // let the text and code highlighting render first
    return () => {
      clearTimeout(t);
      window.removeEventListener("afterprint", after);
      document.title = prev;
    };
  }, [printing]);
  if (!printing) return null;
  return createPortal(<div className="print-view"><Markdown text={printing.markdown} /></div>, document.body);
}
