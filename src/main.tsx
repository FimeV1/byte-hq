import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "./styles.css";
import { App } from "./App";
import { pinViewport } from "./viewport";
import { applyTheme } from "./ui";

applyTheme();
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyTheme());
createRoot(document.getElementById("root")!).render(<App />);
pinViewport();

// The service worker only shows phone notifications (see public/sw.js); it caches nothing.
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
