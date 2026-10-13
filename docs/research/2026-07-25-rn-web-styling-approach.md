# Styling approach for `thin-client/apps/expo`: RN-Web UI kit vs hand-rolled tokens

Research for [issue #40](https://github.com/astefanovic/repcoach/issues/40) (child of map
[#39](https://github.com/astefanovic/repcoach/issues/39)). **Findings only — no decision.**

Date: 2026-07-25. Versions checked against the npm registry and official docs on that date.

> There is no pre-existing `docs/research/` convention in this repo; the closest neighbours are
> `docs/design/*.md` and `docs/adr/`. This file is placed in a new `docs/research/` directory
> because the map issue's ticket taxonomy distinguishes research tickets from design ones.

---

## 1. What is actually in the tree today

Facts, read from the worktree (not inferred):

| Fact | Source |
|---|---|
| Expo `~57.0.4`, React Native `0.86.0`, React `19.2.3`, `react-native-web` `^0.20.0` | `thin-client/apps/expo/package.json` |
| Lockfile resolves `react-native-web@0.20.0`, but `babel-plugin-react-native-web@0.21.2` | `thin-client/pnpm-lock.yaml` (lines 2733, 1479) |
| App deps are 11 packages total; workspace packages depend only on `effect@4.0.0-beta.78` | `apps/expo/package.json`, `packages/*/package.json` |
| No `metro.config.js` and no `babel.config.js` exist in `apps/expo` | directory listing |
| Styling today: 5 `StyleSheet.create` call sites across `App.tsx` + `src/**` | grep |
| `App.tsx` is 279 lines and is the whole shell — no navigation, no theme | `apps/expo/App.tsx` |
| `app.json` hardcodes `"userInterfaceStyle": "light"`; `web` block only sets a favicon | `apps/expo/app.json` |
| Web bundle is **not** produced by `expo export` alone — `expo export` makes the shell, then the JS bundle is **overwritten** with output fetched from a temporary Metro **dev server** at `dev=false&minify=true` | `scripts/Build-WebClient.ps1` |

The last row is the dominant constraint and is discussed in §3.

Two incidental observations worth passing to the owner:

- Expo SDK 57 ships with `react-native-web@~0.21` (npm `latest` is `0.21.2`, published 2026-06-02);
  the app pins `^0.20.0` and the lockfile has the Babel plugin already at `0.21.2`. That is a
  pre-existing minor version skew independent of this decision, but any UI kit that peer-depends
  on RNW will force it to be resolved.
- `app.json` sets `userInterfaceStyle: light`, so dark mode is currently opted out at the config
  level regardless of which styling approach is picked.

---

## 2. The candidates, and their live state

| Library | npm `latest` | Last publish | Shape |
|---|---|---|---|
| `tamagui` / `@tamagui/core` | 2.5.1 | 2026-07-22 | Style engine **+** optional UI kit **+** optimizing compiler |
| `nativewind` | 4.2.6 | 2026-07-08 | Tailwind `className` bindings; v5 is `preview.4` only |
| `uniwind` | 1.10.0 | 2026-07-01 | Tailwind bindings, build-time computed, Expo-only |
| `twrnc` | 4.16.0 | 2025-12-30 | Runtime `tw\`\`` helper; pinned to `tailwindcss <4.0.0` |
| `@gluestack-ui/themed` (v1 line) | 1.1.73 | 2025-09-10 | Legacy; superseded by v5 |
| `react-native-unistyles` | 3.3.0 | 2026-07-10 | StyleSheet superset, C++/JSI, themes + breakpoints |
| `react-native-paper` | 5.15.3 | 2026-06-15 | Material Design component kit |

Sources: npm registry metadata (`npm view <pkg> version time.modified dependencies`).

### Tamagui

- Requires "React 19+, TypeScript 5+, and React Native 0.81+ with New Architecture enabled"
  ([installation docs](https://tamagui.dev/docs/intro/installation)). This repo is React 19.2.3 /
  RN 0.86 — compatible on paper.
- "100% of Tamagui features work at both runtime and compile-time," so the optimizing compiler is
  an *optimisation*, not a correctness requirement (same page). The compiler page frames extraction
  to atomic CSS as build-time, with graceful runtime fallback when it cannot extract
  ([why a compiler](https://tamagui.dev/docs/intro/why-a-compiler),
  [useMedia](https://tamagui.dev/docs/core/use-media)).
- Responsive: media rules from `tamagui.config.ts` become **real CSS media queries** on web, driven
  either by `$gtSm`-style props or the `useMedia()` hook ([useMedia](https://tamagui.dev/docs/core/use-media)).
  This is the strongest *adaptive* story of the candidates — the same media tokens drive both a
  phone shell and a desktop shell without hand-written `Dimensions` listeners.
- Expo setup needs `@tamagui/babel-plugin` in `babel.config.js` and `@tamagui/metro-plugin` in
  `metro.config.js` ([Expo guide](https://tamagui.dev/docs/guides/expo),
  [Metro guide](https://tamagui.dev/docs/guides/metro)). Neither config file exists today, so both
  would be introduced.
- **Dependency weight is the headline risk.** `tamagui` (the kit) fans out to ~70 `@tamagui/*`
  packages at lockstep versions (npm dependency listing). `@tamagui/core` alone is far leaner
  (6 direct deps) and is advertised at "~24KB" gzipped with no outside dependencies
  ([Tamagui 1.0 post](https://tamagui.dev/blog/version-one)).
- **Second risk: it vendors React Native Web.** `@tamagui/react-native-web-internals@2.5.1` is
  published with the literal description "React Native for Web" — i.e. a fork pinned to Tamagui's
  own release train, not to Expo SDK 57's `~0.21`. Anything relying on RNW internals (including the
  existing `src/platform/*` shims) now has two RNW copies in play unless deduped. This deserves an
  empirical check before committing.

### NativeWind

- Stable line is **v4.2.6**. v5 is published only under the `preview` dist-tag (`5.0.0-preview.4`);
  the project itself says v5 "is a pre-release version… not intended for production use"
  ([v5 overview](https://www.nativewind.dev/v5),
  [release plan discussion #1818](https://github.com/nativewind/nativewind/discussions/1818)).
- Web model: "On web, Nativewind is a small polyfill for adding `className` support to React Native
  Web… CSS StyleSheet on web and `StyleSheet.create` for native" (nativewind.dev). So on web the
  styles become real CSS — media queries, dark mode and pseudo-classes are native browser features,
  not a JS runtime.
- Dark mode and responsive design are first-class core concepts in the v4 docs
  ([docs](https://www.nativewind.dev/docs)).
- Setup requires: `tailwindcss`, `react-native-reanimated`, `react-native-safe-area-context`, a
  `tailwind.config.js`, a `global.css`, a Babel preset change, a `withNativeWind` Metro wrapper, and
  switching `app.json` to the Metro web bundler
  ([installation](https://www.nativewind.dev/docs/getting-started/installation)). Note that
  `react-native-reanimated` is a **native** dependency this repo does not currently have.
- Runtime deps are light (`nativewind@4.2.6` → `debug`, `comment-json`, `react-native-css-interop`).

### gluestack-ui

- v5 "requires either **NativeWind v5** … or **UniWind**"
  ([installation](https://gluestack.io/ui/docs/home/getting-started/installation)).
- Same page states: "gluestack-ui v5 does not currently support Next.js. Next.js support will be
  available **as soon as NativeWind v5 adds web support**."
- Read literally, that sentence puts gluestack v5's web story downstream of an unreleased
  NativeWind major. Combined with the legacy `@gluestack-ui/themed` line being untouched since
  2025-09-10, gluestack looks like the weakest fit for a **web-first** target right now.
- Components are vendored into the repo by CLI (`npx gluestack-ui add <component>`), which means the
  code becomes yours to maintain — a genuine advantage for a dep-light codebase, but only if the
  underlying styling layer is stable.

### Uniwind

- Expo's own Tailwind guide now names it alongside NativeWind: "For universal support, use a library
  such as **NativeWind or Uniwind**" ([Expo Tailwind guide](https://docs.expo.dev/guides/tailwind/)).
- Peer deps are Metro-centric (`metro`, `metro-cache`, `metro-transform-worker`, `@expo/metro-config`,
  `tailwindcss >=4`, `react >=19`, `react-native >=0.81`) — it is a Metro transformer, not a native
  module (npm metadata).
- Its README documents iOS / Android / Expo and **does not mention web**
  ([uni-stack/uniwind](https://github.com/uni-stack/uniwind)); the docs site returned 403 to
  automated fetch, so web support could not be confirmed from a primary source. **Treat Uniwind's
  web support as unverified.** It is also v1.10.0 and young.

### react-native-unistyles v3

- A "superset of React Native's StyleSheet" with themes, breakpoints and media queries, explicitly
  designed to share styles across platforms ([introduction](https://www.unistyl.es/v3/start/introduction/)).
- But it "leverages **Nitro Modules** under the hood", uses "JSI bindings" and ships "a cross-platform
  parser written in C++" (same page). That is a native module in the dependency graph of an app whose
  *primary* delivery target is a browser bundle. Web support exists (there are "Custom web" and
  "Web Only Features" sections) but this is the option that most increases native build surface for
  the least web benefit.

### twrnc

- Simplest possible add: one dependency, runtime `tw` helper, no Metro/Babel plugin.
- But it is pinned to `tailwindcss ">=2.0.0 <4.0.0"` and was last published 2025-12-30 — it is on the
  Tailwind v3 branch while Expo's own guide and every other candidate have moved to v4.
- Being a runtime helper, it produces style objects, so on web you get inline styles rather than CSS
  — no free media queries, no `prefers-color-scheme`.

### Hand-rolled tokens over `StyleSheet`

Not a library, so there are no compatibility facts to check — which is itself the point. What you
would be building yourself, and what RNW gives you for free:

- **Free from `react-native-web` already**: `role` → semantic HTML element inference (`role="article"`
  → `<article>`), 40+ `aria-*` props, `tabIndex` for keyboard focus, programmatic focus via
  `UIManager.focus()`, and `href`/`hrefAttrs` turning `Text`/`View` into real `<a>` tags
  ([RNW accessibility docs](https://necolas.github.io/react-native-web/docs/accessibility/)).
  Note the same docs do **not** specify minimum touch-target sizes — that is on you regardless of
  which option is chosen, and it matters for the "gym conditions, sweaty hands" requirement in #39.
- **You would hand-build**: the token set, a theme context (light/dark), and the breakpoint
  mechanism. On RN-Web the idiomatic breakpoint mechanism is `useWindowDimensions()`, which is a JS
  re-render per resize rather than a CSS media query. For an *adaptive* shell (phone bottom-tabs vs
  desktop sidebar) that is actually fine — you are switching whole component trees, not tweaking
  paddings, and the switch has to be a JS decision anyway. It is worse for fine-grained responsive
  polish.
- Expo Metro **does** support importing a global `.css` file on web ("The CSS will be applied to the
  entire page", hot-reloaded), and CSS Modules via `.module.css`, but explicitly notes "global styles
  are **web-only**… on native, all global stylesheets are automatically ignored"
  ([Expo Metro config docs](https://docs.expo.dev/versions/latest/config/metro/)). So a
  hand-rolled approach *can* reach for real CSS media queries on web via a hand-written stylesheet,
  at the cost of a web/native divergence.

---

## 3. The `expo export` constraint — the decisive local factor

`scripts/Build-WebClient.ps1` documents a workaround for
[Effect-TS/effect#6252](https://github.com/Effect-TS/effect/issues/6252): `expo export --platform web`
produces a bundle where `effect@4` beta breaks at boot, while the **same modules bundled through the
Metro dev-server pipeline** with `dev=false&minify=true` work. The script therefore:

1. runs `expo export --platform web` to get `dist/` (index.html + hashed bundle name + favicon), then
2. starts a throwaway Metro dev server, fetches the production bundle from it, and
3. **overwrites only the hashed `.js` file** in `dist/_expo/static/js/web/`.

Upstream status: issue #6252 is **closed**, but the linked report is against `effect@4.0.0-beta.70`
and describes the runtime symptom (`Cannot read properties of undefined (reading 'reasons')` in
`causePartition`) without a documented fix tied to the Metro serializer. This repo pins
`4.0.0-beta.78`. **Whether the workaround is still needed at all is an unverified assumption worth
re-testing before building anything on top of it** — if plain `expo export` now works, most of the
risk below evaporates.

While the workaround stands, it partitions the candidates cleanly:

**Safe under the workaround — anything whose web output lives entirely inside the JS bundle.**
That covers hand-rolled `StyleSheet`, twrnc, and Tamagui-without-static-extraction (Tamagui injects
atomic CSS from JS at runtime when the compiler does not extract, and the docs guarantee runtime
fallback). The overwrite step replaces the JS wholesale, so nothing is lost.

**At risk — anything that emits a separate `.css` artifact.** NativeWind, Uniwind, Tailwind-via-PostCSS
and Tamagui *with* static extraction all produce CSS that `expo export` writes as a hashed file and
links from `index.html`. The script keeps that `index.html` and that CSS from the **export** build,
while the JS comes from a **different** (dev-server) build. Two concrete failure modes:

1. **Hash/content drift** — the exported CSS is generated from the same sources, so Tailwind utility
   class names should match, and this probably works. "Probably" is not a plan; it needs a smoke test.
2. **Double-application** — Metro's dev server serves CSS as a JS module that injects a `<style>` tag,
   so the dev-server JS bundle may carry the CSS *inside* it, on top of the exported `<link>`.
   Harmless in the common case, but it makes CSS ordering/precedence non-deterministic — and Expo's
   Tailwind guide specifically warns about import order so that `node_modules` CSS does not override
   custom styles ([Expo Tailwind guide](https://docs.expo.dev/guides/tailwind/)).

Either way, `Build-WebClient.ps1` would need to grow a CSS-handling step, and the choice of a
CSS-emitting library should be gated on a spike that actually runs the script and loads the result.

---

## 4. Trade-off summary

| | Hand-rolled tokens | Tamagui (`@tamagui/core`) | Tamagui (full kit) | NativeWind v4 | gluestack v5 | Uniwind | Unistyles v3 | twrnc |
|---|---|---|---|---|---|---|---|---|
| New runtime deps | 0 | ~7 | ~70 | 3 + reanimated + safe-area | NativeWind v5 (pre-release) + vendored components | 4 | 1 + native module | 1 |
| Survives the `Build-WebClient.ps1` overwrite | Yes | Yes (runtime CSS) | Yes, unless static extraction is enabled | Needs CSS step | Needs CSS step | Needs CSS step | Needs verification | Yes |
| Real CSS media queries on web | Only if you hand-write CSS | Yes | Yes | Yes | Yes | Unverified | Yes | No |
| Adaptive shell (phone vs desktop) | `useWindowDimensions` (JS) | `$gt*` props / `useMedia` | Same | Tailwind `md:` etc. | Same as NativeWind | Same | Breakpoints API | Manual |
| Dark mode | Build it | Themes built in | Themes built in | `dark:` variant | Inherited | Yes | Themes | Manual |
| Ready-made components | None | None (core is style-only) | Large kit | None | Large kit | None | None | None |
| Adds native build surface | No | No | No | Reanimated (native) | Reanimated (native) | No | Nitro/C++ | No |
| Maintenance signal | n/a | Active (2026-07-22) | Active | Active, but v5 unlanded | Blocked on NativeWind v5 web | Young (v1.x) | Active | Tailwind v3-era |

### Reading of the field

- **gluestack-ui is the weakest fit** for a web-first target today: its v5 line requires an
  unreleased NativeWind major and its own docs tie web/Next.js support to that release landing.
- **twrnc is the weakest fit technically**: Tailwind v3-only, no real CSS on web, oldest release.
- **Unistyles brings a C++/Nitro native module** for a benefit (fast style resolution) that is
  mostly a *native* benefit, on a project whose destination is a browser bundle.
- The genuine contest is **Tamagui core vs NativeWind v4 vs hand-rolled tokens**, and the axis is
  how much of the design language you want to author versus adopt:
  - Hand-rolled keeps the dep graph at zero, keeps `Build-WebClient.ps1` untouched, and matches a
    codebase that currently has *one* runtime dependency (`effect`) — but you write the theme
    context, the token set, and the breakpoint mechanism, and you get no components.
  - Tamagui core buys the adaptive/theming machinery (real CSS media queries, `$gt*` props, themes)
    without the 70-package kit, and its runtime-CSS mode is compatible with the existing build
    workaround. The cost is two new build-config files and a vendored RNW fork in the tree.
  - NativeWind v4 buys the whole Tailwind vocabulary and real CSS on web, at the cost of a CSS
    artifact the build script does not currently handle, plus `react-native-reanimated` as a native
    dependency.
- **Nothing about any of these interacts with Effect at the runtime level.** All are styling layers
  over React components; the Effect layers in `App.tsx` and `packages/client-runtime` are untouched.
  The only Effect interaction is the *build-pipeline* one described in §3, and it is about CSS
  artifacts, not about Effect itself.

## 5. Open questions the owner should resolve before picking

1. **Is the `expo export` workaround still necessary on `effect@4.0.0-beta.78`?** Issue #6252 is
   closed. If plain `expo export` works now, the CSS-artifact risk in §3 largely disappears and
   NativeWind/Uniwind become much more attractive. This is a ~30-minute test and it moves the
   decision more than anything else in this document.
2. **Does the design language need a component kit, or only tokens?** #39's destination is
   "navigation + theme + at least one genuine surface." If the answer is tokens, the full Tamagui kit
   and gluestack drop out and the contest narrows to Tamagui core vs hand-rolled.
3. **Is dark mode in v1?** #39 lists it as "not yet specified" and `app.json` currently pins
   `userInterfaceStyle: light`. A hand-rolled theme context for light-only is trivial; light+dark
   with system following is where a kit starts paying.
4. **Does anything else need Reanimated?** If animation is coming anyway, NativeWind's native
   dependency stops being an incremental cost.
5. **The `react-native-web` 0.20 vs 0.21 skew** should be resolved on its own merits before a kit
   pins it further.

## Sources

- [Expo SDK 57 changelog](https://expo.dev/changelog/sdk-57)
- [Expo Metro config / CSS docs](https://docs.expo.dev/versions/latest/config/metro/)
- [Expo Tailwind CSS guide](https://docs.expo.dev/guides/tailwind/)
- [react-native-web accessibility docs](https://necolas.github.io/react-native-web/docs/accessibility/)
- [Tamagui installation](https://tamagui.dev/docs/intro/installation)
- [Tamagui — why a compiler](https://tamagui.dev/docs/intro/why-a-compiler)
- [Tamagui useMedia](https://tamagui.dev/docs/core/use-media)
- [Tamagui Expo guide](https://tamagui.dev/docs/guides/expo) / [Metro guide](https://tamagui.dev/docs/guides/metro)
- [Tamagui 1.0 announcement (bundle-size claims)](https://tamagui.dev/blog/version-one)
- [NativeWind installation](https://www.nativewind.dev/docs/getting-started/installation)
- [NativeWind v5 overview](https://www.nativewind.dev/v5) and [release plan #1818](https://github.com/nativewind/nativewind/discussions/1818)
- [gluestack-ui v5 installation](https://gluestack.io/ui/docs/home/getting-started/installation)
- [uni-stack/uniwind](https://github.com/uni-stack/uniwind)
- [react-native-unistyles v3 introduction](https://www.unistyl.es/v3/start/introduction/)
- [Effect-TS/effect#6252](https://github.com/Effect-TS/effect/issues/6252)
- npm registry metadata for `tamagui`, `@tamagui/core`, `@tamagui/react-native-web-internals`,
  `nativewind`, `uniwind`, `twrnc`, `@gluestack-ui/themed`, `react-native-unistyles`,
  `react-native-web`, `react-native-paper` (queried 2026-07-25)
- This repo: `thin-client/apps/expo/{package.json,app.json,App.tsx,src/**}`,
  `thin-client/pnpm-lock.yaml`, `thin-client/packages/*/package.json`, `scripts/Build-WebClient.ps1`
