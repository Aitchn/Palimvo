/**
 * Registers the service worker that keeps the app shell available offline (see vite.config.ts,
 * which writes /sw.js at build time). Only in production builds: in dev, Vite serves modules
 * that change on every edit.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err: unknown) => console.warn("service worker registration failed", err));
  };
  // The app starts after an awaited locale download, so the load event may already be over.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
