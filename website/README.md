# Freehop website

The documentation and project site for Freehop, published at
https://jolynstudios.github.io/freehop/. It is a [Docusaurus 3](https://docusaurus.io/) site
(classic preset, TypeScript, React 19) that lives next to the SDK in this repository.

## Requirements

- Node.js 20 or newer
- npm

## Develop

```sh
cd website
npm ci --ignore-scripts
npm start          # http://localhost:3000/freehop/
```

`npm start` and `npm run build` first run `scripts/copy-lib.mjs`, which copies Freehop's own
browser modules (`../src/client/*.mjs`, `../src/sdk/client.mjs`, `../src/sdk/ticket.mjs`) into
`static/lib/`. The live call (`/demo`), Hopper, games and "what the gate sees" demo load that real code at
runtime with `import(/* webpackIgnore: true */ url)`, so the site always runs the SDK it
documents. `static/lib/` is generated and git-ignored; run `npm run copy-lib` after changing
the SDK while the dev server is running.

Docusaurus computes theme overrides when the dev server starts. After adding a new file under
`src/theme/`, restart `npm start`.

## Build and preview

```sh
npm run build      # writes build/; fails on any broken link or anchor
npm run serve      # serves build/ at http://localhost:3000/freehop/
npm run typecheck  # optional: TypeScript check of the site code
```

The build is strict: `onBrokenLinks`, `onBrokenAnchors` and `onBrokenMarkdownLinks` all throw.

With the built site running, check sound playback from the repository root:

```sh
node test/browser/demo-playback.mjs http://localhost:3000/freehop/ first
node test/browser/demo-playback.mjs http://localhost:3000/freehop/ second
```

These checks use fake capture devices and public trackers with normal Chromium autoplay policy. They inject a playback denial on each joiner, verify the recovery button, and check that camera changes preserve playing audio. They require internet access; reports and screenshots go to ignored `test/evidence/`.

For a deterministic local-gate check of the games and Hopper (two real browser peers, fake
capture devices), start the built site and run from the repository root:

```sh
node test/browser/site-smoke.mjs http://localhost:3000/freehop/
```

This substitutes the signalling endpoint only inside Playwright. It checks movement, wall
collision, player messages, remote video, controls, Orbital collection, Hopper chat and leaving.
Production demos keep their public tracker configuration. Evidence goes to ignored `test/evidence/`.

## Deploy

The site is static. Deploy the contents of `build/` to GitHub Pages for the
`jolynstudios/freehop` repository. The committed [Pages workflow](../.github/workflows/pages.yml) runs
`npm ci --ignore-scripts`, the [audit gate](scripts/audit-gate.mjs) and `npm run build` in `website/`.
The audit gate allows only two currently unpatched advisories in build-only dependencies; any new finding fails the build.
The build has read-only permissions; only the separate deployment job gets Pages/OIDC write
permissions. Actions are pinned to commit SHAs. The site expects to be served at
`/freehop/` (`baseUrl` in `docusaurus.config.ts`). `static/.nojekyll` keeps GitHub Pages from
ignoring files that start with an underscore. Whatever hosts the site must serve the `.mjs`
files in `lib/` with a JavaScript MIME type: browsers refuse module scripts otherwise.
`npm run serve` does; check `curl -I <site>/lib/client/peerlane.mjs` after the first deploy.

## Layout

| Path | What |
|---|---|
| `docs/` | Documentation pages (MDX). Sidebar order: `sidebars.ts` |
| `src/pages/index.tsx` | Home page, assembled from `src/components/home/` |
| `src/pages/demos.tsx` | All interactive demos on one page |
| `src/pages/demo.tsx` | The live call, rendered only in the browser |
| `src/components/world/` | Three.js connection sculpture and playable game renderer |
| `src/components/scenes/` | Technical diagrams for concept pages |
| `src/components/demos/` | Network tools, Signal Run / Orbital controls, live call |
| `src/components/hopper/` | Hopper room, device preview and chat |
| `src/components/home/` | Large game showcases |
| `src/theme/Footer/` | The site footer (replaces the classic theme's footer) |
| `src/css/custom.css` | Design tokens and global styles |
| `scripts/copy-lib.mjs` | Copies the SDK's browser modules into `static/lib/` |

## Design system

The [Refero design lock](DESIGN.md) documents the three supplied references and their roles.
The shell is black and monochrome. Instrument Serif is used for editorial headlines, Inter
for UI and prose, and IBM Plex Mono for code. Color belongs to rendered media, syntax and
actual network status. Large media sections lead; product controls remain quiet.

`src/css/custom.css` defines the shared tokens. The site uses dark mode throughout. Concept
pages use technical diagrams; the original illustration primitives remain in the source
archive but are not the active visual system. Three.js renders pause off screen and respect
reduced motion. The hero has a pause control; games provide a map view when WebGL is unavailable.
No participant portraits, peer counts or integration claims are fabricated for presentation.

## Keeping documentation in sync

After SDK changes, update the root `SDK.md`, `ARCHITECTURE.md`, `PROTOCOL.md` and relevant
`docs/sdk/` and `docs/concepts/` pages. `docs/protocol.md` is a maintained website version,
not a generated copy. Keep quickstart snippets consistent with admission and STUN settings. Label the runtime of every example (browser, backend, gate, Electron main or session host), and distinguish complete runnable examples from application-specific snippets. Privacy claims must acknowledge connection metadata and the shared-key trust between room members.
When verification changes, update root `README.md` and `RESULTS.md`, `docs/results.mdx`,
`docs/intro.mdx` and the home page. Describe the 40-run NAT matrix as developer-run, home-lab testing with simulated networks, and
keep it distinct from targeted re-tests or real-network evidence.

## Writing rules

- Facts only, from `SDK.md`, `PROTOCOL.md`, `RESULTS.md` and the code. Freehop is alpha. Describe
  the 40-run matrix as home-built, simulated-network testing run in a home lab—not independent
  lab qualification or field testing—and say what is not verified yet.
- Say "Freehop" in prose. "Peerlane" is the codename and appears only where wire identifiers
  carry it (`peerlane/v1/` salt, `peerlane/v1|` AAD prefix, TURN realm, data channel label).
- Copyright line: "© 2026 Jolyn Studios". Code is Apache-2.0; documentation and the protocol
  specification are CC BY 4.0. Freehop is provided as is, without warranty of any kind.

## License

The site's code is licensed under Apache-2.0 and its documentation under CC BY 4.0, like the
rest of Freehop. © 2026 Jolyn Studios.
