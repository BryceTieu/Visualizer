import "./app.scss";
import App from "./App.svelte";

const app = new App({
  target: document.body!,
});

// Register the service worker only in production builds. It uses cache-first for
// the JS/CSS bundle, which breaks hot-reload and can serve stale (un-optimized)
// modules during development.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((error) => {
    console.error(`Service worker registration failed: ${error}`);
  });
}

export default app;
