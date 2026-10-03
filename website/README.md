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
`static/lib/`. The live call (`/demo`) and the "what the gate sees" demo load that real code at
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

## Deploy

The site is static. Deploy the contents of `build/` to GitHub Pages for the
`jolynstudios/freehop` repository. The committed [Pages workflow](../.github/workflows/pages.yml) runs
`npm ci --ignore-scripts`, `npm audit --audit-level=moderate` and `npm run build` in `website/`.
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
| `src/components/illustrations/` | Flat illustration primitives: `House`, `Globe`, `Mailbox`, `Envelope`, `PaperPlane`, `HopArc` and `Mover`, `Lighthouse`, `Cloud`, `Wall`, plus `Person`, `Ball`, `Key`, `Bubble`, `NameTag`, `RelayTower` and `Coin` |
| `src/components/scenes/` | One illustrated scene per concept page, composed from the primitives |
| `src/components/demos/` | Path finder (`pathRules.ts` holds its rules), escalation timeline, gate demo, cost calculator, live call |
| `src/components/home/` | Home page sections and the hero planet |
| `src/theme/Footer/` | The site footer (replaces the classic theme's footer) |
| `src/css/custom.css` | Design tokens and global styles |
| `scripts/copy-lib.mjs` | Copies the SDK's browser modules into `static/lib/` |

## Design system

Two layers, used deliberately:

- **Scenes** (home page and illustrations): Signal Yellow `#ffe600`, Globe Azure `#007fff`,
  Roof Coral `#ef3b2c` (illustrations only), Charcoal Ink `#333333` and white. Display type is
  Changa One. Flat fills with chunky outlines: no gradients, no shadows.
- **Documentation**: white paper, Ink `#303055`, Slate `#403f53`, Fog, Mist and Lavender Mist
  `#e8e8f2`; Rubik for text and IBM Plex Mono for code. Code colours appear only inside code.
  The code card carries the only shadow.

All tokens are CSS custom properties at the top of `src/css/custom.css`. The site is light
mode only, so the illustration palette stays intact. Never put white text on yellow: use
charcoal on yellow and white only on azure, at large sizes.

Illustrations draw around their own origin and are placed with `x`, `y`, `rotate` and
`scale`, so scenes are plain SVG composition. Every animation stops for visitors who prefer
reduced motion: CSS animations through a media query, and SVG motion (`Mover`) only renders
after hydration when `useMotionAllowed()` allows it.

## Keeping documentation in sync

After SDK changes, update the root `SDK.md`, `ARCHITECTURE.md`, `PROTOCOL.md` and relevant
`docs/sdk/` and `docs/concepts/` pages. `docs/protocol.md` is a maintained website version,
not a generated copy. Keep quickstart snippets consistent with admission and STUN settings. Label the runtime of every example (browser, backend, gate, Electron main or session host), and distinguish complete runnable examples from application-specific snippets. Privacy claims must acknowledge connection metadata and the shared-key trust between room members.
When verification changes, update root `README.md` and `RESULTS.md`, `docs/results.mdx`,
`docs/intro.mdx` and `src/components/home/Proof.tsx`. The current suite has 151 passing tests;
the historical 40-run NAT matrix must remain distinguished from targeted requalification.

## Writing rules

- Facts only, from `SDK.md`, `PROTOCOL.md`, `RESULTS.md` and the code. Freehop is alpha and
  lab-qualified; say what is not verified yet.
- Say "Freehop" in prose. "Peerlane" is the codename and appears only where wire identifiers
  carry it (`peerlane/v1/` salt, `peerlane/v1|` AAD prefix, TURN realm, data channel label).
- Copyright line: "© 2026 Jolyn Studios". Code is Apache-2.0; documentation and the protocol
  specification are CC BY 4.0. Freehop is provided as is, without warranty of any kind.

## License

The site's code is licensed under Apache-2.0 and its documentation under CC BY 4.0, like the
rest of Freehop. © 2026 Jolyn Studios.
