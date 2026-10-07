# Freehop — Refero design lock

Designing the Freehop developer site and demos for people building browser games, Electron apps and platforms. The primary action is to try a working demo, followed by the SDK quickstart. Existing API information, comparisons and limits stay available.

## Research, 7 October 2026

Refero MCP was connected at `https://api.refero.design/mcp`. The project-local authenticated config is excluded from git. The `refero-design` skill is installed in `.agents/skills/refero-design`.

Tools used: `refero_search_styles` (cinematic/WebGL, developer SDK and named-brand searches), `refero_get_style`, `refero_search_screens`, `refero_get_screen`.

The public style UUIDs did not resolve through MCP (`INVALID_STYLE_UUIDS`). The supplied public pages and their screenshots were inspected directly. MCP searches resolved the corresponding Resend and Active Theory catalog records and an adjacent Apple AirPods Pro record; the user's AirPods 5 page remains the specific media-composition reference.

| Reference | Public reference | MCP catalog ID |
|---|---|---|
| Active Theory | https://styles.refero.design/style/3416bd14-96bb-4c23-bd01-b2ea178ba5ce | `9d795615-79d0-4544-ac5e-2858971c3b3b` |
| Resend | https://styles.refero.design/style/0d914ef0-fa84-4c60-a9aa-cef0b5eb6e5d | `b2f7a9d7-ba46-4c00-bc73-426969097ff9` |
| Apple AirPods 5 | https://styles.refero.design/style/cfcd001c-e812-4126-9bdf-1f16b68d182e | adjacent AirPods Pro: `bbb27bcc-7d86-402c-87bd-c44be626c8b5` |
| Resend open source screen | https://refero.design/pages/2970b1e5-7926-4f3e-a7bd-cc9f81e011ad | `2970b1e5-7926-4f3e-a7bd-cc9f81e011ad` |

## Build target

Direct build from the user's explicit references. Active Theory owns the full-bleed canvas and scene-first composition. Resend contributes only the editorial display / UI / code distinction and restrained code presentation. Apple contributes the scale of media chapters and quiet controls, not its white canvas or purchase colors.

Preserve: pure black, monochromatic chrome, dominant dimensional scene, low density, generous spacing. The hero is a live Three.js woven signal field, not a simulated call or a claim about live users. Actual gameplay appears in the demo showcases.

| Decision | Source and role | Implementation |
|---|---|---|
| Full-bleed `#000` canvas | Active Theory: scene owns the viewport | No blue page fill, ambient CSS wash or framed hero dashboard |
| Large live 3D object | Active Theory: rendered media carries light/color | Fine illuminated strands forming an open waveform surface; bounded pointer rotation; pause and reduced motion |
| White and gray shell | Active Theory | White text, `#a1a4a5` secondary copy, `#292d30` structural edges |
| Editorial hero type | Resend: display only | Instrument Serif as an openly available high-contrast display substitute; UI remains sans |
| Code is its own voice | Resend | IBM Plex Mono retained as the project's existing readable code face; syntax colors stay in code |
| Large demo chapters | Apple: media first | A large actual game render, then sparse product details; no decorative feature-card grid |
| Clear build entry | Resend open source screen | Short install command, real SDK sample, source and reference links |
| Small-room honesty | Freehop implementation and user brief | No fabricated peers, benchmarks, shipped game integrations or built-in AI claims |

Reject: colored headline words, generic blue cards, numbered decorative feature blocks, fake video participants, heavy shadows, repeated slogan sections and keyword strips.

Tokens: black canvas; `#0b0b0c` raised surface; `#fff` headings; `#c6c6c6` body; `#a1a4a5` metadata; `#292d30` borders. Ghost actions use neutral borders and 5–6px radii. Fully rounded controls are reserved for the hero's compact actions. Status colors carry actual network state. Documentation remains comfortably readable.

## Verification

Compare desktop and mobile renders to this lock. Check scene scale, typography, black canvas, limited chrome, product links, keyboard focus, reduced motion, canvas fallback, overflow and demo controls. A successful build alone is insufficient.

## Release verification

- Production build and TypeScript check passed.
- Desktop (1440 px) and mobile (390 px) route checks: no horizontal overflow or uncaught browser errors. Mobile navigation checked.
- Automated WCAG A/AA checks on home, docs, games guide, playground, Hopper, Signal Run, Orbital and Comms lab: no violations found. This is an automated check, not a claim of complete accessibility certification.
- Two real Chromium peers through a local gate: movement and collision, encrypted player messages, remote video, mic/camera and adaptive controls, departure, Orbital scoring, Hopper lobby/chat/leave/rejoin. The test also exercises the WebGL-unavailable map fallback.
- `npm run ship`: all four gates passed, including 173 unit tests and Chromium/Firefox/WebKit media, multigate outage, key rotation and SDK example checks. A pre-existing macOS TCP-reset assumption in the timeout test was corrected; its deadline and server-counter assertions remain.
- Website audit gate passed with the repository's existing build-tool advisory allowance. No new allowlist entry was added.
- Fonts are self-hosted. Reduced-motion scenes render on demand; active scenes are capped at 30 fps and pause off screen. Game movement messages are coalesced below the receiver limit.

The original site is retained at git tag `archive/pre-rebrand-2026-10-07` and in a local archive outside the repository. This release changes the website, examples and documentation; the published SDK remains `0.1.0-alpha.3`.

## Hero revision

The user approved the site and logo but rejected the animated rings. Retain the logo and
all page composition. Replace only the hero artwork with an open, folded signal field:
fine luminous strands, restrained pearl / steel-blue / warm-white light, and slow motion.
Active Theory remains the immersive-media reference; the existing Resend typography and
large uninterrupted media treatment remain. A fresh Refero MCP style search confirmed the
dark-canvas / luminous-graphic direction. No circular sculpture, particle cloud, fabricated
call activity or new interface decoration. Update the social preview to match the hero.

Revision checks passed: desktop/mobile render without overflow or browser errors; active motion, pause, pointer interaction, reduced-motion freeze, and non-WebGL fallback; TypeScript and production build. Logo assets are unchanged.
