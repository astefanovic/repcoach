import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The commit this bundle is built from (issue #111).
 *
 * The server states the commit it is *running* in `serverGetConfig`; baking the
 * build's commit in here is the other half of that handshake. Without it, a
 * `dist` built days before the server it is served by drifts silently — which
 * is precisely how a widened `TokenUsage` turned every Intake into "the coach
 * lost its connection" while the socket was never once dropped.
 *
 * Resolved from this config's own directory so the answer is about the checkout
 * being built, whatever directory the build was invoked from. Falls back to
 * `"unknown"`, which the client reads as "cannot tell" and stays quiet about —
 * a build outside a git checkout is a legitimate thing to do, and it must not
 * present as a broken client.
 */
function buildRef(): string {
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const ref = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return ref === "" ? "unknown" : ref;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  define: {
    __BUILD_REF__: JSON.stringify(buildRef()),
  },
});
