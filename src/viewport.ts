// iOS keyboard: Safari doesn't resize the page when the keyboard opens, it pans the whole page up and
// pushes the header off screen. While typing, size the
// app to the visible area above the keyboard and cancel the pan, so only the composer moves.
//
// Only pinned while a text field is focused. With no keyboard it falls back to 100dvh: on the foldable's
// inner screen iOS can leave visualViewport stuck at the keyboard-open height after it closes.

function typing() {
  const el = document.activeElement as HTMLInputElement | null;
  return matchMedia("(pointer: coarse)").matches && !!el &&
    (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !["file", "button", "checkbox", "radio"].includes(el.type)));
}

export function pinViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    const box = document.querySelector<HTMLElement>(".scroll");
    const atBottom = !!box && box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const kb = typing();
    root.classList.toggle("kb-open", kb);
    if (kb) root.style.setProperty("--vvh", vv.height + "px");
    else root.style.removeProperty("--vvh");
    window.scrollTo(0, 0);
    if (atBottom && box) box.scrollTop = box.scrollHeight; // keep the latest message in view
  };
  // Focus/blur as well as resizes: some iOS builds change heights late, so re-measure after the keyboard animates out.
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => {
    for (const ms of [50, 350, 800]) setTimeout(update, ms);
  });
  window.addEventListener("resize", update);
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}
