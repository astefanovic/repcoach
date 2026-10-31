/// <reference types="vite/client" />

/**
 * The git commit this bundle was built from, substituted at build time by
 * `vite.config.ts` (issue #111). `"unknown"` when the build could not consult
 * git — see `runtime/useServerBuildRef.ts` for why that is treated as "cannot
 * tell" rather than as a mismatch.
 */
declare const __BUILD_REF__: string;
