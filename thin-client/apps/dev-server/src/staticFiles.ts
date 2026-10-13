import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

/**
 * Static web-client serving for the production server (Step 2A / task 2A.6,
 * t3code model): the server serves the thin client's `apps/web` (Vite) build
 * output itself, so the phone UX is just "open the server URL in a browser"
 * — the app loads from the server and connects back to the same origin
 * (`Connection.resolveServerBaseUrls`), exactly like t3code's
 * `staticAndDevRouteLayer` (`apps/server/src/http.ts`) + primary-environment
 * target. No Metro, no Expo Go, no build-time URL baking.
 *
 * Mirrors t3code's handler semantics: `/` -> `index.html`, path-traversal
 * guarded, extension-less paths -> their `index.html`, and any miss falls back
 * to the SPA's `index.html` (client-side routing). Registered as a `GET *`
 * catch-all so the more-specific `/rpc` WebSocket route still wins.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const makeStaticRoutesLayer = (staticDir: string) =>
  HttpRouter.add(
    "GET",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request);
      if (url._tag === "None") {
        return HttpServerResponse.text("Bad Request", { status: 400 });
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticRoot = path.resolve(staticDir);

      const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
      const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
      const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
      const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
      const hasPathTraversalSegment = staticRelativePath.startsWith("..");
      if (
        staticRelativePath.length === 0 ||
        hasRawLeadingParentSegment ||
        hasPathTraversalSegment ||
        staticRelativePath.includes("\0")
      ) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }

      const isWithinStaticRoot = (candidate: string) =>
        candidate === staticRoot ||
        candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

      let filePath = path.resolve(staticRoot, staticRelativePath);
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }

      const ext = path.extname(filePath);
      if (ext === "") {
        filePath = path.resolve(filePath, "index.html");
        if (!isWithinStaticRoot(filePath)) {
          return HttpServerResponse.text("Invalid static file path", { status: 400 });
        }
      }

      const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
      if (fileInfo === null || fileInfo.type !== "File") {
        // SPA fallback: unknown paths serve the app shell (client-side routing),
        // mirroring t3code. A missing index.html means no client build exists.
        const indexData = yield* fileSystem
          .readFile(path.resolve(staticRoot, "index.html"))
          .pipe(Effect.orElseSucceed(() => null));
        if (indexData === null) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        return HttpServerResponse.uint8Array(indexData, {
          status: 200,
          contentType: "text/html; charset=utf-8",
        });
      }

      const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
      if (data === null) {
        return HttpServerResponse.text("Internal Server Error", { status: 500 });
      }
      return HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType: CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        headers: { "X-Content-Type-Options": "nosniff" },
      });
    }),
  );
