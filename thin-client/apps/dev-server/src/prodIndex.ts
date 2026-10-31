import { exitOnSignals, productionConfigFromEnv, startProductionServer } from "./productionMain.ts";

/**
 * Production entrypoint (Step 2A / task 2A.5): the persistent RepCoach server
 * for the always-on home host (ADR 0005). `pnpm --filter @repcoach/dev-server
 * start` runs this; `pnpm repcoach start` (`cli.ts`) does the same plus a web
 * build freshness check. Unlike `index.ts` (the dev server) this build mounts
 * no `/__test__/*` control channel, and only paired devices reach `/rpc`.
 *
 * Configuration (env vars) is documented on `productionMain.ts`.
 */
exitOnSignals(await startProductionServer(productionConfigFromEnv()));
