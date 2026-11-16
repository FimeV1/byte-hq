import { useEffect, useState } from "react";
import { Download, MessageSquare, Trash2 } from "lucide-react";
import { hq } from "./api";
import { openChatById, openModal, toast, useStore } from "./store";
import type { MediaItem } from "./types";
import { Dialog } from "./ui";

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** Every image and video made in HQ, newest first: open the chat it's in, download it, or delete it. */
export function GalleryDialog() {
  const [list, setList] = useState<{ items: MediaItem[]; bytes: number } | null>(null);
  const [q, setQ] = useState("");
  const [sure, setSure] = useState<string | null>(null);
  const sessions = useStore((s) => s.sessions);
  const load = () => hq.mediaList().then(setList).catch((e) => toast(`Couldn't list them: ${e instanceof Error ? e.message : e}`));
  useEffect(() => void load(), []);
  const known = (o: { backend: string; sid: string }) => Object.entries(sessions).some(([k, l]) => k.startsWith(o.backend + "|") && l.some((x) => x.id === o.sid));
  const t = q.trim().toLowerCase();
  const shown = (list?.items || []).filter((m) => !t || m.prompt.toLowerCase().includes(t));
  const del = async (m: MediaItem) => {
    await hq.mediaDelete(m.file).catch((e) => toast(`Couldn't delete it: ${e instanceof Error ? e.message : e}`));
    setSure(null);
    load();
  };
  return (
    <Dialog title="Images and videos" onClose={() => openModal(null)}>
      <div className="gallery">
        <div className="gallery-top">
          <span className="grow">{list ? `${list.items.length} file${list.items.length === 1 ? "" : "s"} · ${formatBytes(list.bytes)}` : "Loading…"}</span>
          {(list?.items.length || 0) > 6 && <input className="input" placeholder="Search descriptions" value={q} onChange={(e) => setQ(e.target.value)} />}
        </div>
        {list && list.items.length === 0 && <div className="vault-note">Nothing yet. Make one with the picture button or /image in the message box.</div>}
        <div className="gallery-grid">
          {shown.map((m) => {
            const src = `/hq/media/${m.file}`;
            const owner = m.owners.find(known);
            return (
              <figure key={m.file} className="g-item">
                {m.kind === "image" ? (
                  <a href={src} target="_blank" rel="noopener" title="Open full size"><img src={src} alt={m.prompt} loading="lazy" /></a>
                ) : (
                  <video src={src} controls playsInline preload="metadata" />
                )}
                <figcaption>
                  <span className="clamp2" title={m.prompt}>{m.prompt || <em>No description</em>}</span>
                  <small>{new Date(m.at).toLocaleDateString()} · {formatBytes(m.size)}{!owner ? " · not in any chat" : ""}</small>
                </figcaption>
                <div className="g-acts">
                  {owner && (
                    <button type="button" className="act" title="Open the chat" aria-label="Open the chat" onClick={() => openChatById(owner.backend, owner.sid) && openModal(null)}>
                      <MessageSquare size={15} />
                    </button>
                  )}
                  <a className="act" href={src} download={m.file} title="Download" aria-label="Download"><Download size={15} /></a>
                  <button
                    type="button"
                    className={"act" + (sure === m.file ? " danger-on" : "")}
                    title={sure === m.file ? "Click again to delete" : "Delete"}
                    aria-label="Delete"
                    onBlur={() => setSure(null)}
                    onClick={() => (sure === m.file ? del(m) : setSure(m.file))}
                  >
                    {sure === m.file ? "Delete?" : <Trash2 size={15} />}
                  </button>
                </div>
              </figure>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
