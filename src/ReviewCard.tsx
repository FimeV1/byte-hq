import { memo, useMemo } from "react";
import { LoaderCircle, ScanSearch, X } from "lucide-react";
import { isAuto, markReviewAsked, reviewAsked, sendPrompt, startReview, useStore } from "./store";
import { buildTurns, viewTurn } from "./turns";
import { Markdown } from "./Markdown";
import { CopyButton } from "./Chat";

/**
 * Under a turn that changed files: ask whether to have the changes reviewed, then show the review.
 * `ask` is true only for the newest finished turn, so older turns don't nag.
 */
export const ReviewCard = memo(function ReviewCard({ turnUserId, ask }: { turnUserId: string; ask: boolean }) {
  const review = useStore((s) => (s.current?.sessionId ? s.chat[s.current.sessionId]?.reviews[turnUserId] : undefined));
  const reviewChat = useStore((s) => (review ? s.chat[review.sid] : undefined));
  const running = useStore((s) => (review ? !!s.active[review.sid] : false));
  const asked = useStore(() => reviewAsked(turnUserId));
  const auto = useStore((s) => isAuto(s)); // in Auto chats the fix is sent automatically

  const result = useMemo(() => {
    const turns = buildTurns(reviewChat?.messages || []);
    const t = turns[turns.length - 1];
    return t ? viewTurn(t, running) : null;
  }, [reviewChat?.messages, running]);

  if (review) {
    const text = result?.answer || "";
    const thinking = running && !text;
    return (
      <div className="rv">
        <div className="rv-head">
          {running ? <LoaderCircle size={15} className="spin" /> : <ScanSearch size={15} />}
          <span>{running ? `${review.label} is reviewing the changes…` : `Review by ${review.label}`}</span>
          {!running && /VERDICT:\s*OK/i.test(text) && <span className="rv-ok">Looks good</span>}
          {!running && /VERDICT:\s*FIX/i.test(text) && <span className="rv-fix">Needs fixes</span>}
          {!running && text && <span className="spacer" />}
          {!running && text && <CopyButton text={text.replace(/^.*VERDICT:.*$/im, "").trim()} label="Copy the review" />}
        </div>
        {thinking && (
          <div className="rv-note">
            "Reading the diff (a model that has to load first can take a minute or two)…"
          </div>
        )}
        {text && <Markdown className={"rv-body" + (running ? " caret" : "")} text={text.replace(/^.*VERDICT:.*$/im, "").trim()} />}
        {result?.error && <div className="notice err">{result.error}</div>}
        {!running && text && !/VERDICT:\s*OK/i.test(text) && !(auto && /VERDICT:\s*FIX/i.test(text)) && (
          <div className="rv-btns">
            <button
              type="button"
              className="btn primary"
              onClick={() =>
                sendPrompt(
                  `${review.label} independently reviewed your last changes and reported:\n\n${text}\n\nFix the real problems it found. If you disagree with a point, say why instead of changing the code.`,
                ).catch(() => {})
              }
            >
              Ask it to fix these
            </button>
          </div>
        )}
      </div>
    );
  }

  if (!ask || asked) return null;
  return (
    <div className="rv ask">
      <div className="rv-head">
        <ScanSearch size={15} />
        <span>Review these changes?</span>
        <span className="spacer" />
        <button type="button" className="act" onClick={() => markReviewAsked(turnUserId)} aria-label="No review" title="No"><X size={15} /></button>
      </div>
      <div className="rv-note">
        Auto's model reviews it (your main model if it's free, otherwise the fallback). It reads only your request and the diff, and can't change anything.
      </div>
      <div className="rv-btns">
        <button type="button" className="btn" onClick={() => markReviewAsked(turnUserId)}>No</button>
        <button type="button" className="btn primary" onClick={() => startReview(turnUserId)}>Yes</button>
      </div>
    </div>
  );
});
