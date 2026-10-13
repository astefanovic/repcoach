# Navigation / routing options for an Expo + react-native-web app that must also be a desktop web app

- **Issue:** [astefanovic/repcoach#41](https://github.com/astefanovic/repcoach/issues/41) (`wayfinder:research`)
- **Date:** 2026-07-25
- **Status:** findings — no decision. The pick belongs to #44.
- **Sources:** primary only (docs.expo.dev, reactnavigation.org, necolas.github.io/react-native-web, npm registry manifests). URLs in [Sources](#sources).

---

## The question

The thin client currently has **no navigation at all**. It must grow an IA (see `docs/design/ui-surfaces.md`: Today, Logging, Coaching feed, Proposal card, Decision log, Plan view, Intake, Deliberation-run visibility, Settings, Goal & constraints, Progress) and must run as a **desktop web app** as well as a phone app. What are the real routing options, what does each cost, and what do they do to URL behaviour, the home server's static route, adaptive shells, and `scripts/Build-WebClient.ps1`?

---

## Executive summary of the options

| | expo-router | react-navigation direct | hand-rolled |
|---|---|---|---|
| Current version | `expo-router@57.0.8` (npm manifest) | `@react-navigation/native@7.3.14` | n/a |
| Web maturity | first-class; web is a shipped target with three `web.output` modes | supported but explicitly caveated (no gestures, animations off on native-stack) | whatever you build |
| URLs / history | automatic, file-derived, every screen deep-linkable | manual `linking` config object, History API sync | manual |
| Entry-point change | **yes** — `main: "expo-router/entry"` + `app/` dir | no | no |
| New deps | 6+ (`expo-router`, `react-native-screens`, `react-native-safe-area-context`, `expo-linking`, `expo-constants`, `expo-status-bar`) | 2–4 (`@react-navigation/native` + one navigator + `react-native-screens`, `react-native-safe-area-context`) | 0 |
| Server change needed | **none** for `web.output: "single"` (SPA fallback already exists) | none | none |
| Adaptive shell seam | `expo-router/ui` headless `Tabs`/`TabList`/`TabTrigger`/`TabSlot`, plus layout routes | `tabBar` / `drawerContent` render props, `tabBarPosition`, `drawerType: 'permanent'` | you own it |
| Build-script risk | `expo export` runs as step 1 of `Build-WebClient.ps1` — **static/server output modes interact with the effect@4 export bug**; `single` is the low-risk mode | none | none |

Two facts dominate the shape of the decision:

1. **The home server already does SPA fallback.** `thin-client/apps/dev-server/src/staticFiles.ts` (`makeStaticRoutesLayer`) serves `index.html` for any path miss. So client-side routing with real URLs works **today with zero server change** — verified in the code, quoted below.
2. **`expo-router` in SDK 57 is no longer a react-navigation wrapper.** Expo's own intro page says it is "Built on top of [React Native Screens]" and the `expo-router@57.0.8` manifest lists **no `@react-navigation/*` dependency** (it depends on `react-native-screens@^4.26.0` and `react-native-drawer-layout@^4.2.2`). This is a change from expo-router's historical framing; it means "expo-router vs react-navigation" is now a genuine fork in the road, not a thin-vs-thick wrapper of the same runtime.

---

## Option 1 — expo-router (file-based)

**Version / support.** `expo-router@57.0.8`, versioned in lockstep with the SDK (this repo is on `expo: ~57.0.4`, `apps/expo/package.json`). Peer deps: `expo`, `react`, `react-native`, `react-native-screens@^4.26.0`, `@expo/metro-runtime@^57.0.7`; **`react-native-web` is an *optional* peer** and `react-dom` likewise — i.e. web is explicitly a supported-but-optional target, not an afterthought. Install set per Expo's own install page: `expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-status-bar`.

**Benefits.**
- "Every screen in your app is automatically deep linkable, making any route in your app shareable with links" — no hand-maintained `linking` map that drifts from the navigator tree.
- One route tree drives Android and web ("Android, iOS, and web share a unified navigation structure, with the ability to drop-down to platform-specific APIs at the route level"). Given `ui-surfaces.md` has ~10 surfaces, a file tree is cheaper to keep honest than a nested config object.
- Layout routes (`app/_layout.tsx`) give a natural place to hang a form-factor-dependent shell.
- Headless tab primitives exist for the desktop shell (see [Adaptive shells](#adaptive-shells)).

**Costs.**
- **Entry-point change is mandatory.** `package.json` must set `"main": "expo-router/entry"`. Today `apps/expo/package.json` has `"main": "index.ts"` and `apps/expo/index.ts` calls `registerRootComponent(App)`. That file goes away; `App.tsx`'s body has to move into `app/_layout.tsx`.
- **A new `app/` directory** is required (`app/_layout.tsx` or `src/app/_layout.tsx`).
- `app.json` additions: `scheme` (for deep linking) and, per Expo's web section, `web.bundler: "metro"`; optionally `experiments.typedRoutes: true`.
- Babel: `babel-preset-expo` — Expo says you "can delete the file entirely" if you have no custom config. This repo has **no `babel.config.js` and no `metro.config.js`** in `apps/expo` (verified by listing the directory), so nothing to reconcile.
- Interacts with `Build-WebClient.ps1` — see [Build-script interaction](#build-script-interaction). This is the real cost, not the file moves.

---

## Option 2 — react-navigation used directly

**Version / support.** `@react-navigation/native@7.3.14`; getting-started states "Version: 7.x", peers `react >= 18.2.0`, `react-native: *`, and for the docs' stated minimums `react-native >= 0.72.0`, `expo >= 52`. This repo is `react-native: 0.86.0`, `react: 19.2.3`, `expo: ~57.0.4` — comfortably inside.

**Web support is documented and caveated.** From the web-support page:
- "The navigators require using React Native for Web to work on the web."
- Native Stack **disables animations and gestures entirely on web**; Stack disables animations by default and has no gestures; Drawer uses CSS transitions with no gestures.
- URL integration is opt-in: you must configure `linking`, and you should navigate with `Link`/`Button` rather than `navigation.navigate()` "to ensure anchor tags render correctly" (i.e. real `<a href>` — middle-click, copy-link, SEO).
- Explicitly: React Navigation apps "are SPAs requiring index.html to serve all routes, necessitating hosting provider configuration to avoid 404 errors." **That configuration already exists here.**

**Benefits.**
- No entry-point change, no `app/` directory, no build-pipeline surface change. `index.ts` → `registerRootComponent(App)` stays; `App.tsx` gains a `NavigationContainer` and a navigator tree. This is the smallest diff of the three real options.
- `useNavigationBuilder` + `createNavigatorFactory` + `createScreenFactory` give a documented escape hatch to write a **custom navigator** if neither tabs nor drawer fits the desktop shell.
- Zero interaction with `expo export`'s output mode, so zero new exposure to the effect@4 export bug.

**Costs.**
- The `linking` config is a hand-maintained parallel structure to the navigator tree ("the linking works by translating the URL to a valid navigation state and vice versa using the configuration provided"). Two things to keep in sync, forever, across ~10 surfaces.
- Documented sharp edge: `initialRouteName` in linking config "will add the screen to React Navigation's state only. If your app is running on the Web, the browser's history will not contain this screen." Back-button behaviour therefore needs deliberate design, not defaults.
- Bundle size: the docs recommend `React.lazy()` + dynamic imports for screen-level code splitting — you own that, whereas expo-router derives it from the route tree.

---

## Option 3 — hand-rolled router

Not documented by anyone; the cost is entirely ours. What it would have to reimplement, using the same primary sources as a checklist: History API push/replace + `popstate` handling, URL↔state serialisation (what react-navigation's `linking` does), focus/unmount semantics per screen, back-button semantics on Android (react-navigation gets this via `BackHandler` integration), and a `<a href>`-rendering link component so desktop affordances (open-in-new-tab, copy link) work.

**Benefit:** zero new runtime deps; total control; no `expo export` output-mode entanglement at all; trivially compatible with `Build-WebClient.ps1`.

**Cost:** everything above, plus you lose react-native-screens-backed native screen semantics on Android. React Native for Web itself does **not** offer routing — its docs cover `View`/`Text`/`Image`/`TextInput`/`ScrollView`, styling, layout localisation and gestures, with **no mention of routing or navigation** (absence, not an explicit "out of scope" statement — flagging that as an inference, not a quote).

Realistic framing: this is only credible if the IA collapses to a handful of top-level surfaces and no nested/modal stacks. `ui-surfaces.md` describes modal-ish flows (Proposal card expand, Intake, in-workout logging that "past Sessions reopen in the same surface"), which is exactly the territory where hand-rolled routers accrete.

---

## URL behaviour and static serving

### What the server does today — verified in code

`thin-client/apps/dev-server/src/staticFiles.ts`, `makeStaticRoutesLayer(staticDir)`, registered in `apps/dev-server/src/server.ts:128`. Its documented semantics, quoting the file's own header comment: `"/" -> index.html`, path-traversal guarded, "extension-less paths -> their `index.html`, and any miss falls back to the SPA's `index.html` (client-side routing). Registered as a `GET *` catch-all so the more-specific `/rpc` WebSocket route still wins."

Concretely, in the handler:

```ts
const ext = path.extname(filePath);
if (ext === "") {
  filePath = path.resolve(filePath, "index.html");
  ...
}
const fileInfo = yield* fileSystem.stat(filePath)...
if (fileInfo === null || fileInfo.type !== "File") {
  // SPA fallback: unknown paths serve the app shell (client-side routing)
  const indexData = yield* fileSystem.readFile(path.resolve(staticRoot, "index.html"))...
```

Two behaviours matter:
1. **Extension-less path → `<path>/index.html` first.** So a `static` export laid out as `dist/plan/index.html` would be served correctly *as a per-route document*.
2. **Miss → root `index.html` with 200.** So a `single` export serves the shell for `/plan`, `/feed/123`, anything. Refresh-in-place and deep links work with **no server change**.

Note the fallback returns **200, not 404**, for genuinely unknown paths. That is correct SPA behaviour and wrong for a static-per-route site (a typo'd URL renders the app shell rather than a 404). Only relevant if `web.output: "static"` is chosen.

### What each Expo `web.output` mode produces (verified)

- **`single`** — "exports your Expo app to a single-page app with only one index.html output." Expo's publishing guide says this mode requires the host to "rewrite all requests to index.html" (Netlify `/*  /index.html  200`, Vercel `rewrites` to `/`). **Our static route already does exactly this.**
- **`static`** — "exports your Expo app to a statically generated web app"; "The export process generates individual HTML files for each route", e.g. `dist/blog/alpha.html`, `dist/blog/beta.html`. Expo's publishing guide says for `static` you can "skip this step" — **no rewrite rules needed**. Caveats: dynamic routes "will not work out of the box" and need `generateStaticParams`; "Rendering at request-time is not supported"; static and server rendering cannot be mixed.
- **`server`** — server functions and API routes; "no HTML files are pre-generated." Irrelevant here: the app is served by our own Effect HTTP server, not an Expo server runtime.

Note the shape mismatch worth flagging: Expo's static output is documented as `blog/alpha.html`, while our handler's extension-less branch resolves `/blog/alpha` → `blog/alpha/index.html`. Whether SDK 57's static export emits `alpha.html` or `alpha/index.html` is **not something I verified for this SDK** — the docs page shows the `.html` form. If `static` were chosen, `staticFiles.ts` would likely need a `<path>.html` probe alongside the `<path>/index.html` probe. **Inferred, needs an actual export to confirm.**

### Browser back/forward, refresh, deep links

- **expo-router:** deep-linkability is the stated core property ("deep links always work, for every page").
- **react-navigation:** on web it "uses the History API to sync the URL with the browser", so back/forward work automatically once `linking` is configured. Caveat above re `initialRouteName` not entering history.
- **hand-rolled:** you implement `pushState`/`popstate` yourself.

All three refresh-in-place correctly against the current server, because of the existing fallback.

### e2e impact

Every Playwright flow under `thin-client/e2e/flows/` does `await page.goto("/")` against `baseURL: EXPO_WEB_URL` (`e2e/playwright.config.ts:15`). Adding routes doesn't break them as long as `/` still lands on the default surface; but the flows currently assume everything is co-rendered in one screen (`renders-repcoach`, `log-straight-session`, `g1-offline-outbox`, …). Introducing navigation means those flows must navigate to reach the widgets they assert on — that cost lands on the adversarial e2e author, not on the router choice.

---

## Adaptive shells

**Yes — one navigator tree can drive different shells per form factor, under either library.** The seam is a render prop / slot, not a second tree.

**React Navigation, two documented seams:**
- `tabBarPosition` on the bottom-tab navigator accepts `bottom` (default), `top`, `left`, `right`; "When positioned on the left or right, the tab bar is styled as a sidebar, which is particularly useful for displaying a sidebar on larger screens and a bottom tab bar on smaller screens via responsive logic." This is the cheapest possible phone-tabs/desktop-sidebar switch: **one option, driven by width.**
- `tabBar` render prop: "Function that returns a React element to display as the tab bar", receiving `{ state, descriptors, navigation }`. Constraint to respect: "You **cannot** use the `useNavigation` hook inside the `tabBar`" — use the passed `navigation`.
- Drawer: `drawerContent({ state, navigation, descriptors })`, and `drawerType` of `front | back | slide | permanent`, where `permanent` is "always-visible sidebar layout"; the docs recommend conditionally setting `permanent` on larger screens (≥768px) and `front` below.
- If neither fits (e.g. a genuine desktop **multi-pane** — list + detail side by side, which `ui-surfaces.md`'s Decision log and Coaching feed / Proposal card pairing implies), the documented route is a **custom navigator**: `useNavigationBuilder(router, options)` returning `{ state, navigation, descriptors, NavigationContent }`, wrapped by `createNavigatorFactory`, screens declared via `createScreenFactory`. You render by "looping through `state.routes` and calling `descriptors[route.key].render()`" — which is exactly the primitive needed to render **two routes simultaneously** in two panes from one state tree. Also `BottomTabView` can be driven directly, and there is an `UNSTABLE_router` prop for alternative routers (name signals instability).

**expo-router:** `expo-router/ui` exposes headless tab primitives — `Tabs` (wrapper `<View>`), `TabList` (container for triggers), `TabTrigger` (a `Pressable` with `name` and `href`), `TabSlot` (renders the selected tab). All render "unstyled as a `<View>`"; `asChild` forwards props to your own components; the `TabList` can be hidden and `TabTrigger`s placed anywhere (i.e. in a sidebar); `TabSlot` takes a `renderFn` to control how screens are rendered. Combined with layout routes (`_layout.tsx`) and Expo's "drop-down to platform-specific APIs at the route level", one route tree with a width-conditional layout component is the intended pattern.

**The honest caveat:** for a simple tabs↔sidebar swap, both are one-tree, low-cost. For a true **desktop multi-pane** (two routes visible at once), I found no first-class documented API in either — React Navigation's `useNavigationBuilder` + `descriptors[key].render()` is the documented primitive you'd build it on; expo-router's `TabSlot renderFn` is the nearest analogue but the docs describe it for "animations or state persistence", not simultaneous multi-route rendering. **Treat multi-pane as custom work under either option.**

---

## Migration cost from the current state

**Current state, verified.** `thin-client/apps/expo/App.tsx` is 279 lines, a single default-export `App()` returning **one `<View style={styles.container}>`** containing, flat: a `RepCoach` `<Text>`, `ConnectionIndicator`, `PrescriptionPanel` (which nests `LoggingGrid`), `OutboxPendingIndicator`, `DeliberationStateIndicator`, `IntakeFlow`, `CoachingFeed`, `StatusBar`. There is **no router anywhere in the repo** — a repo-wide grep for `expo-router|@react-navigation|linking` over `.ts/.tsx/.json` (excluding `node_modules`/lockfile) returns exactly one hit, an unrelated comment in `packages/client-runtime/src/connection/supervisor.ts:34`.

**Structural facts that bear on migration:**
- `apps/expo/package.json`: `"main": "index.ts"`, deps include `expo ~57.0.4`, `react-native 0.86.0`, `react-native-web ^0.20.0`, `react 19.2.3`, `react-dom 19.2.3`, `effect 4.0.0-beta.78`. **`react-native-screens` and `react-native-safe-area-context` are absent** — both options need them added.
- `apps/expo/index.ts` — 8 lines, `registerRootComponent(App)`.
- **No `babel.config.js`, no `metro.config.js`** in `apps/expo` (directory listing: `App.tsx app.json assets index.ts package.json src tsconfig.json`). Per Expo's monorepo guide, "Expo configures Metro automatically for monorepos… You don't have to manually configure Metro when using monorepos if you use `expo/metro-config`" (SDK 52+). So **no metro work is required for the pnpm layout under any option** — verified against Expo's doc, and consistent with the absence of the file.
- `apps/expo/app.json` has `web: { favicon }` only — **no `web.bundler`, no `web.output`, no `scheme`**.
- `apps/expo/tsconfig.json` extends `expo/tsconfig.base` with `strict` and `allowImportingTsExtensions`.
- Workspace: `pnpm-workspace.yaml` → `apps/*`, `packages/*`, `e2e`; the expo app consumes `@repcoach/client-runtime` and `@repcoach/contracts` as `workspace:*`.

**Per-option migration cost:**

*expo-router*
1. `npx expo install expo-router react-native-safe-area-context react-native-screens expo-linking expo-constants expo-status-bar` (`expo-status-bar` already present).
2. `apps/expo/package.json`: `"main": "index.ts"` → `"main": "expo-router/entry"`; **delete `apps/expo/index.ts`**.
3. Create `apps/expo/app/_layout.tsx`. The whole bootstrap block of `App.tsx` — the module-level `resolveServerBaseUrls`/`target`/`dependencies` constants (lines 25–58) and the `Effect.runFork` supervisor/outbox/prescription-cache scope in `App()`'s `useEffect` (lines 172–205) — is **root-layout-shaped**: it must run once, above every route, and hand `supervisor` / `manager` / `prescriptionCache` / `loggedSessionId` down. That means a React context provider in `_layout.tsx`, which is new code this app doesn't have today (everything is currently prop-drilled from one component).
4. Split the flat children into route files (`app/index.tsx`, `app/feed.tsx`, `app/plan.tsx`, …); `src/` components move unchanged.
5. `app.json`: add `scheme`, `web.bundler: "metro"`, and a `web.output` decision (see below).
6. pnpm note: Expo's monorepo guide offers `nodeLinker: hoisted` in `pnpm-workspace.yaml` as the escape hatch "if you encounter issues with isolated installations". Not needed pre-emptively; flagged as the known remedy.

*react-navigation*
1. Add `@react-navigation/native` + one or two navigator packages + `react-native-screens`, `react-native-safe-area-context`.
2. `index.ts` and `main` unchanged; `App.tsx` keeps its bootstrap `useEffect` verbatim and wraps a `NavigationContainer` + navigator around the existing children. Context provider still wanted, but the bootstrap doesn't move.
3. Write and maintain a `linking` config; add `scheme` to `app.json` for native deep links.
4. `app.json` untouched otherwise; **no `web.output` decision at all** (which is the point — see next section).

*hand-rolled*
1. No deps, no config, no entry change. Everything is the router code you write.

---

## Build-script interaction

`scripts/Build-WebClient.ps1` is a documented workaround, quoting its own synopsis: "`expo export --platform web` produces a bundle where effect@4 beta breaks at boot ('Cannot read properties of undefined (reading 'reasons')' -- Effect-TS/effect#6252 …). The SAME modules bundled through the Metro DEV SERVER pipeline with dev=false&minify=true work correctly." Its three steps: (1) run `expo export --platform web` for "the correct dist/ shell (index.html + hashed bundle filename + favicon + metadata)"; (2) start a temporary Metro dev server, scrape the bundle `src` out of Metro's index HTML, flip `dev=true→false`/`lazy`/`hot` and add `minify=true`, and **overwrite the single hashed bundle file**; (3) kill Metro. The overwrite target is picked as `Get-ChildItem (dist\_expo\static\js\web\*.js) | Select-Object -First 1` — i.e. **it assumes exactly one entry bundle**.

Consequences per option:

- **react-navigation / hand-rolled:** fully compatible, unchanged. The dist shape stays `index.html` + one bundle; routing is entirely inside the bundle, and the bundle is produced by the Metro-dev-server path that is known to work with effect@4. **No new risk.**
- **expo-router with `web.output: "single"`:** dist shape is the same (one `index.html`, one entry bundle), and the SPA fallback in `staticFiles.ts` already covers it. This is the mode with the smallest blast radius against the existing script. **Inferred** that the `Select-Object -First 1` bundle-picking still resolves to the right file — expo-router may introduce additional chunks under `_expo/static/js/web/`, in which case "first .js" becomes ambiguous and the script needs a manifest-aware pick. **Must be confirmed by running an actual export; I did not run one.**
- **expo-router with `web.output: "static"`:** two distinct new risks, both **unverified inferences** that a decision ticket should test rather than assume:
  1. Static rendering executes the route modules **in Node at export time** to produce per-route HTML. The app's module scope pulls in `effect@4` (`App.tsx` lines 4–9, plus `@repcoach/client-runtime`). The known effect@4 failure is described in the script as living "inside expo's export-only serializer pipeline", which is a *bundling* problem — but static rendering adds a *server-render* execution of the same modules that has never been exercised here. Independent risk, same blast radius (a broken build).
  2. The step-2 overwrite trick patches the client bundle *after* `expo export` already emitted the per-route HTML. If any HTML was rendered using the broken export bundle's semantics, patching the JS afterwards may leave HTML and JS mismatched. **Speculative — flagging the shape of the risk, not asserting it.**
  Against that, `static` output is what makes URLs work with **no** SPA fallback and correct 404s — but we don't need that, because the fallback already exists.
- **`web.output: "server"`:** incompatible with this deployment model — the app is served by our own Effect `HttpRouter` static route, not an Expo server runtime.

---

## Open uncertainties

1. **Does SDK 57's `expo export` emit more than one JS chunk under expo-router?** If yes, `Build-WebClient.ps1`'s `Select-Object -First 1` and its single-bundle overwrite strategy break. Not verified — requires running the export. **The single highest-value spike before #44 decides.**
2. **Does `web.output: "static"` survive effect@4?** Unverified; the known bug is export-serializer-shaped, static rendering adds a Node-execution path on top.
3. **Static output's on-disk layout** (`plan.html` vs `plan/index.html`) versus `staticFiles.ts`'s extension-less → `<path>/index.html` resolution. Docs show `blog/alpha.html`; our handler probes `blog/alpha/index.html`. Only matters if `static` is chosen.
4. **expo-router's react-navigation lineage.** Expo's intro page says "built on top of React Native Screens" and the 57.0.8 manifest carries no `@react-navigation/*` dep — but it does carry `react-native-drawer-layout@^4.2.2` (a react-navigation-org package shipped standalone). Whether react-navigation APIs (`useNavigationBuilder`, custom navigators) are still reachable from an expo-router app in SDK 57 is **not established by the docs I read**. This matters: if they aren't, the custom-navigator escape hatch for desktop multi-pane exists under option 2 but **not** under option 1.
5. **Desktop multi-pane** has no first-class documented API in either library. Both would be custom.
6. **react-native-web on routing** — its docs simply don't discuss it. I read that as "out of scope"; that is an inference from absence, not a quoted statement.
7. **e2e rewrite scope.** All 13 flow files `goto("/")` and assert on co-rendered widgets. Any routing introduces navigation steps into those flows. Size unestimated here.

---

## Sources

- Expo Router installation — https://docs.expo.dev/router/installation/
- Expo Router introduction — https://docs.expo.dev/router/introduction/
- Expo Router custom tabs (`expo-router/ui`) — https://docs.expo.dev/router/advanced/custom-tabs/
- Expo static rendering (`web.output: "static"`) — https://docs.expo.dev/router/web/static-rendering/
- Expo server rendering (`web.output: "server"`) — https://docs.expo.dev/router/web/server-rendering/
- Expo publish websites (SPA fallback / rewrites) — https://docs.expo.dev/guides/publishing-websites/
- Expo monorepos (Metro auto-config, pnpm `nodeLinker: hoisted`) — https://docs.expo.dev/guides/monorepos/
- `expo-router@57.0.8` manifest — https://registry.npmjs.org/expo-router/latest
- React Navigation getting started (7.x, peers) — https://reactnavigation.org/docs/getting-started
- React Navigation web support — https://reactnavigation.org/docs/web-support
- React Navigation configuring links — https://reactnavigation.org/docs/configuring-links
- React Navigation custom navigators (`useNavigationBuilder`) — https://reactnavigation.org/docs/custom-navigators
- React Navigation bottom tabs (`tabBar`, `tabBarPosition`) — https://reactnavigation.org/docs/bottom-tab-navigator
- React Navigation drawer (`drawerContent`, `drawerType: 'permanent'`) — https://reactnavigation.org/docs/drawer-navigator
- `@react-navigation/native@7.3.14` manifest — https://registry.npmjs.org/@react-navigation/native/latest
- React Native for Web docs — https://necolas.github.io/react-native-web/docs/

**Repo files read:** `thin-client/apps/expo/App.tsx`, `thin-client/apps/expo/index.ts`, `thin-client/apps/expo/package.json`, `thin-client/apps/expo/app.json`, `thin-client/apps/expo/tsconfig.json`, `thin-client/apps/dev-server/src/staticFiles.ts`, `thin-client/apps/dev-server/src/server.ts`, `thin-client/packages/client-runtime/src/connection/serverTarget.ts`, `thin-client/pnpm-workspace.yaml`, `thin-client/package.json`, `thin-client/e2e/playwright.config.ts`, `thin-client/e2e/flows/*.spec.ts`, `scripts/Build-WebClient.ps1`, `docs/design/ui-surfaces.md`, `docs/design/open-questions.md`.
