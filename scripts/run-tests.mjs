// Thin-client test runner: the real-socket integration suites are reliable
// ONLY when each runs in its OWN vitest process. Measured on this Windows host
// with the always-on home server (:4020) up: `clientIntegration` alone is 6/6,
// but the same file inside a single full-suite `vitest run` fails ~3/6 — the
// shared parent process's esbuild transform for all 34 files starves the
// socket forks' loopback accept loop (`connect ETIMEDOUT` / 30s test timeout).
// `fileParallelism: false` (one fork at a time under a shared parent) is NOT
// enough; separate INVOCATIONS are.
//
// So: run every non-socket test in one fast parallel pass, then run each
// socket file in its own `vitest run <file>` invocation. Sequential invocations
// never overlap, so nothing starves the socket servers. Exits non-zero if any
// pass fails. See the `test-flakiness-socket-suites` memory note (the old
// docs/temp/ handover is in git history).
//
// One residual is genuinely environmental and not fixable in test code: while
// the home server runs a heavy deliberation (an LLM pass can peg the box for
// tens of seconds), loopback connects on the whole machine starve past any
// sane per-connect timeout. Such a spike is finite, so a failed socket file is
// retried with escalating settles (5s, then 15s) — enough total wait to ride
// out a deliberation run and land once the box frees up. A file that fails all
// three attempts is a real failure.
const RETRY_SETTLES_MS = [5_000, 15_000];
import { setTimeout as delay } from "node:timers/promises";

import { spawnSync } from "node:child_process";

const SOCKET_FILES = [
  "apps/server/src/clientIntegration.test.ts",
  "apps/server/src/outboxIntegration.test.ts",
  "apps/server/src/prescriptionCacheIntegration.test.ts",
  "apps/server/src/productionDurability.test.ts",
  "apps/server/src/productionServer.test.ts",
  "apps/server/src/server.test.ts",
];

const vitest = (args) => {
  const result = spawnSync("pnpm", ["exec", "vitest", "run", ...args], {
    stdio: "inherit",
    shell: true,
  });
  return result.status ?? 1;
};

const passthrough = process.argv.slice(2);
const failures = [];

// Pass 1: everything EXCEPT the socket files, in one fast parallel invocation.
console.log("\n=== [1/7] non-socket suites (parallel) ===");
const excludeArgs = SOCKET_FILES.flatMap((f) => ["--exclude", `**/${f.split("/").pop()}`]);
if (vitest([...excludeArgs, ...passthrough]) !== 0) failures.push("non-socket suites");

// Passes 2..7: each socket file in its own process, retried with escalating
// settles if a transient home-server load spike starves its connects.
for (let i = 0; i < SOCKET_FILES.length; i++) {
  const file = SOCKET_FILES[i];
  console.log(`\n=== [${i + 2}/7] ${file} (isolated process) ===`);
  let passed = vitest([file, ...passthrough]) === 0;
  for (let attempt = 0; !passed && attempt < RETRY_SETTLES_MS.length; attempt++) {
    const settle = RETRY_SETTLES_MS[attempt];
    console.log(`\n--- ${file} failed; retry ${attempt + 1}/${RETRY_SETTLES_MS.length} after ${settle / 1000}s settle (transient load?) ---`);
    await delay(settle);
    passed = vitest([file, ...passthrough]) === 0;
  }
  if (!passed) failures.push(file);
}

console.log("\n============================================");
if (failures.length > 0) {
  console.log(`FAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("All suites passed.");
