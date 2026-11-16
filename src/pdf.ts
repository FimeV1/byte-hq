// PDFs attached in the message box are turned into their text here, in the browser, so every model can read them
// (most can't take a PDF file). The PDF reader (pdf.js) is loaded only the first time a PDF is attached.

const MAX_CHARS = 400_000; // about 100K tokens: more than that would not fit most models anyway

/** The text of a PDF, page by page. Empty when it has none (a scan: only pictures of text). */
export async function pdfText(file: File): Promise<{ text: string; pages: number; cut: boolean }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const parts: string[] = [];
    let size = 0;
    let cut = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) (lines.push(line), (line = ""));
      }
      if (line) lines.push(line);
      const text = lines.join("\n").replace(/[ \t]+\n/g, "\n").trim();
      if (text) parts.push(`--- Page ${n} ---\n${text}`);
      size += text.length;
      if (size > MAX_CHARS) {
        cut = n < doc.numPages;
        break;
      }
    }
    let text = parts.join("\n\n");
    if (text.length > MAX_CHARS) (text = text.slice(0, MAX_CHARS)), (cut = true);
    return { text, pages: doc.numPages, cut };
  } finally {
    doc.destroy();
  }
}
