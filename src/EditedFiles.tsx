import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { FileDiff } from "./types";

type Line = { kind: "add" | "del" | "ctx" | "hunk"; text: string; a?: number; b?: number };

/**
 * Turn unified-diff text into rows with old/new line numbers. Hunk headers say how many lines
 * follow, and only that many are read, so file headers between hunks ("Index:", "---", "+++")
 * are never mistaken for changed lines. The text may hold several patches for one file.
 */
function parsePatch(patch: string): Line[] {
  const out: Line[] = [];
  let a = 0;
  let b = 0;
  let leftA = 0;
  let leftB = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      if (out.length) out.push({ kind: "hunk", text: "" });
      a = Number(hunk[1]);
      b = Number(hunk[3]);
      leftA = hunk[2] === undefined ? 1 : Number(hunk[2]);
      leftB = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (leftA <= 0 && leftB <= 0) continue; // outside a hunk
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    if (raw.startsWith("+")) (out.push({ kind: "add", text: raw.slice(1), b: b++ }), leftB--);
    else if (raw.startsWith("-")) (out.push({ kind: "del", text: raw.slice(1), a: a++ }), leftA--);
    else (out.push({ kind: "ctx", text: raw.slice(1), a: a++, b: b++ }), leftA--, leftB--);
  }
  return out;
}

const FileRow = memo(function FileRow({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ef-file">
      <button type="button" className="ef-row" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={14} className={"ef-chev" + (open ? " open" : "")} />
        <span className="ef-name" title={file.file}><bdi>{file.file}</bdi></span>
        <span className="ef-add">+{file.additions}</span>
        <span className="ef-del">−{file.deletions}</span>
      </button>
      {open && (
        <div className="ef-diff">
          {file.status === "deleted" && !file.patch.trim() ? (
            <div className="ef-empty">File deleted</div>
          ) : (
            <table>
              <tbody>
                {parsePatch(file.patch).map((l, i) =>
                  l.kind === "hunk" ? (
                    <tr key={i} className="d-hunk"><td colSpan={3}>⋯</td></tr>
                  ) : (
                    <tr key={i} className={"d-" + l.kind}>
                      <td className="d-n">{l.a ?? ""}</td>
                      <td className="d-n">{l.b ?? ""}</td>
                      <td className="d-t"><span className="d-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>{l.text || " "}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
});

export const EditedFiles = memo(function EditedFiles({ files }: { files: FileDiff[] }) {
  if (!files.length) return null;
  return (
    <div className="ef">
      <div className="ef-title">Edited files</div>
      {files.map((f) => <FileRow key={f.file} file={f} />)}
    </div>
  );
});
