# Freehop — Refero design lock

Current design, 7 October 2026. Freehop is a calling SDK for small meeting rooms, in-app conversations, shared workspaces, Electron apps, communities and games. The homepage leads to the working demos and the SDK quickstart. The published package is `0.1.0-alpha.4`, with TypeScript declarations for all 15 public entry points.

## References

The three user-supplied Refero references define the composition. Refero MCP research used `refero_search_styles`, `refero_get_style`, `refero_search_screens` and `refero_get_screen` at `https://api.refero.design/mcp`. The authenticated project-local config is excluded from git.

The public style UUIDs did not resolve through MCP (`INVALID_STYLE_UUIDS`), so their public pages and screenshots were inspected directly. MCP resolved the Active Theory and Resend records and an adjacent AirPods Pro record. The supplied AirPods page contributes only the scale and continuity of media sections, not Apple branding.

| Reference | Public reference | MCP catalog ID |
|---|---|---|
| Active Theory | https://styles.refero.design/style/3416bd14-96bb-4c23-bd01-b2ea178ba5ce | `9d795615-79d0-4544-ac5e-2858971c3b3b` |
| Resend | https://styles.refero.design/style/0d914ef0-fa84-4c60-a9aa-cef0b5eb6e5d | `b2f7a9d7-ba46-4c00-bc73-426969097ff9` |
| Apple AirPods 5 | https://styles.refero.design/style/cfcd001c-e812-4126-9bdf-1f16b68d182e | adjacent AirPods Pro: `bbb27bcc-7d86-402c-87bd-c44be626c8b5` |
| Resend open source screen | https://refero.design/pages/2970b1e5-7926-4f3e-a7bd-cc9f81e011ad | `2970b1e5-7926-4f3e-a7bd-cc9f81e011ad` |

## Current build target

Preserve the approved logo, monochrome shell, large uninterrupted media, generous spacing and thin separators. Keep the SDK example immediately after the hero, followed by Hopper and the live calling demo, then practical use-case recipes.

| Decision | Reference and role | Implementation |
|---|---|---|
| Large uninterrupted hero media | Active Theory: composition and lighting | A live Three.js woven signal field with bounded pointer rotation, pause control and static fallback |
| Restrained interface | Resend: shell and code presentation | Flat neutral surfaces, thin rules, quiet controls and short install example |
| Media scale | Supplied AirPods reference: composition only | Spacious sections without decorative feature-card grids |
| Inter for headlines, UI and prose | Refero Linear changelog (`11d3e58a-87d7-4a9a-bbf5-720f4fd3ffc6`): typography only | Medium display weight, tight tracking and a clear heading scale |
| IBM Plex Mono | Existing code typography | Code samples and technical labels; fonts are self-hosted |
| System, Light and Dark | User request; Refero Ui (`c14c0a94-1037-449e-bf5b-4cb972656ac7`): neutral color roles | Follow the OS by default, persist explicit choice and allow return to System |
| Practical positioning | SDK capabilities and user brief | “Voice and video, inside your app.” and “Build your first call.” |
| Working demonstrations | Actual Freehop consumers | Hopper and the live call only; use-case recipes are integration ideas |

Dark mode uses a black canvas, near-black surfaces, pale type and neutral borders. Light mode uses white and near-white surfaces with dark text. Media stages remain dark. Status colors report actual network state; syntax colors stay in code. The calculator result owns its foreground/background palette, and result numbers have no decorative highlight.

Avoid decorative font changes, colored headline words, generic blue cards, fake video participants, invented usage counts, repeated slogans and unverified integration or AI claims. Freehop has no built-in AI model, transcription service or agent runtime.

## Motion and accessibility

Hero animation is capped at 30 fps, pauses off screen, respects reduced motion and has a user pause control. Reduced-motion scenes render on demand. WebGL failure shows a static fallback. Product controls need visible keyboard focus, clear labels and usable mobile layouts.

## Verification

Changes must pass the site TypeScript check and strict production build. Check desktop and mobile rendering, light/dark/system preferences, overflow, keyboard controls, reduced motion, pause and canvas fallback. Automated WCAG A/AA checks supplement visual inspection; they do not constitute full accessibility certification.

The current design was checked at 320, 390, 768 and 1440 px across representative homepage, documentation and Hopper views. Both themes, use-case anchors, readable results/calculator panels and theme persistence passed. Local-gate browser checks verified two-peer audio/video, controls, chat and Hopper leave/rejoin.

## Maintenance and archive

Use `src/css/custom.css` for shared design tokens. Keep the social preview consistent with the rendered homepage. Preserve protocol identifiers in code and examples; use Freehop in product prose.

The original site is preserved at git tag `archive/pre-rebrand-2026-10-07` and in an external local archive. Git history retains superseded design iterations; this file describes the active site only.
