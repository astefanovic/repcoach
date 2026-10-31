import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { registerRestNotificationWorker } from "./platform/restNotifier.ts";
import { RuntimeProvider } from "./runtime/RuntimeProvider.tsx";
import "./theme.tokens.css";

// `RuntimeProvider` sits above the router, not inside a route: the supervisor,
// the outbox and its flusher are the app's lifetime, not a page's. Navigating
// must not tear down the websocket or interrupt a drain (#50).
// The rest-timer worker has to be active before the first rest ends; see
// `public/rest-sw.js`. It asks for nothing and caches nothing.
registerRestNotificationWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RuntimeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </RuntimeProvider>
  </StrictMode>,
);
