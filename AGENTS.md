# AGENTS.md

Guidance for anyone (human or agent) working in this repository. The rules come with their
reasons; if a reason does not apply to your situation, the escape hatch says what to do instead of
working around the rule.

## What this repo is

`insight-next` is a private prototype that rebuilds the Neat Insight frontend in Angular on
SiMa.ai's UI kit, `@sima/neat-ui` (repo `justin-guth-sima/neat-ui`). The design and its decisions
are in `docs/superpowers/specs/2026-10-21-insight-overhaul-design.md`.

- `frontend/`: the Angular app. Flask serves its build from `frontend/dist`.
- `neat_insight/`: the Flask backend (the `/api/` endpoints, media, MJPEG previews) that also
  serves the built frontend, falling back to `index.html` for client-side routes.
- `webrtc/`: vf, the Go media and metadata server the Viewer gets its video from.
- `UPSTREAM.md`: the `sima-neat/insight` baseline this repo was copied from. Backend changes from
  upstream are ported by hand, and every port appends a line to its log.

## Rules for the frontend

These are the kit's rules seen from an app. The kit's own `AGENTS.md` explains them from the
inside; its showcase app (`npm start` in the kit) shows every component in both themes and is the
first place to look before building something.

**Reuse what `@sima/neat-ui` offers, and import UI only from it.**
Why: each kit component carries the theme, accessibility and behaviour decisions already made, and
the kit's underlying libraries (Spartan UI, Lucide, Tailwind) stay swappable only while no app
touches them. ESLint rejects imports of those libraries. Escape hatch: if nothing fits, go to the
next rule.

**If nothing fits, stop and propose a kit change instead of working around it.**
A kit change is a new component or a new input on an existing one. Why: a workaround here is
invisible to the other apps on the kit and hardens into a divergent fork; a kit change is reviewed
once and benefits every app. Escape hatch: write the proposal (what you need, why the existing
components fall short, the API you would like) and raise it with the maintainer before building; do
not ship the workaround in the meantime.

**Style through theme tokens and component inputs.**
Why: tokens are what make light and dark work and keep later rebranding a kit change. Overrides
(deep selectors, `!important`, hard-coded colours) silently break in one theme or after a kit
update. There are no colour literals (hex, `rgb()`, `hsl()`) in the app; Stylelint enforces this
on every component stylesheet. The app has no Tailwind setup of its own, so utility classes in app
templates do nothing reliable. Besides the colours and `--radius`, the kit stylesheet defines a
short layout set: `--neat-space-2`, `--neat-space-3`, `--neat-space-4`, `--neat-space-6` (0.5,
0.75, 1 and 1.5rem) for gaps and insets, and `--neat-text-xs`, `--neat-text-sm` (0.75 and
0.875rem); use them instead of literal sizes. Escape hatch: a look that tokens and inputs cannot
reach is a kit gap; raise it as a kit change.

**Component styles live in a `.css` file next to the component, referenced with `styleUrl`, and
never `@import` anything.**
Why: Stylelint reads only stylesheets, so a style written inline in the decorator (`styles:`) would
escape the colour-literal rules; ESLint rejects inline styles (templates may stay inline). The kit
stylesheet reaches the app once, through `angular.json`; an `@import` in a component (of
`tailwindcss`, `tw-animate-css` or the kit stylesheet) would pull a second copy of styles into it,
so Stylelint rejects `@import`. Escape hatch: none; a component that needs no styles has no
stylesheet.

**Pages fill the content area the shell gives them and own at most one scroll context.**
Why: nested scroll containers and hard-coded sizes break on other screens and in kiosk mode, where
the rail and top bar are gone. Wrap each page in `<neat-page>` and never measure or hard-code the
shell's size. `neat-page` also gives the page its inset (`padding="page"`, the default), so pages
add no padding of their own; full-bleed content such as the Viewer's grid uses `padding="none"`.
Escape hatch: a page that needs more than one independently scrolling region is a kit change, so
the layout becomes a supported component.

**Raw browser APIs used for performance stay isolated, outside change detection, with tests.**
WebRTC, video, canvas and Web Audio are fine where performance needs them. Why: such code is fast
because it bypasses Angular; spread through components it makes change detection unpredictable and
bugs hard to reproduce. Keep it in a small unit with a narrow interface and its own tests. Escape
hatch: if the isolation costs too much for a case, say so in the PR and agree the exception before
merging.

## How the frontend is put together

- **Pages are routes.** `app.routes.ts` loads each page lazily and titles it with its rail label;
  the title strategy turns that into `Neat Insight · <Page>`. `navigation.ts` lists the rail items.
  A new page needs both, and `navigation.spec.ts` checks that they agree. The old app's paths keep
  working: `/rtsp` and `/visualizer` redirect to their pages, and `/` and unknown paths (old
  `/workspace` and `/genai` bookmarks) land on Streaming.
- **Build output.** `npm run build` writes the app to `frontend/dist` with `index.html` at its root,
  where Flask (`_resolve_frontend_dist`) and `build.sh` look for it. Fonts and other media go to
  `dist/assets/` instead of Angular's default `media/`: Flask's `/media/<path>` route serves
  Insight's media library and would shadow them. Keep built files away from `/media/` and from
  `/static/`, which the hosted mode's public origin routes to vf. The initial-bundle budget warns
  at 700 kB, as in the kit showcase, because the kit's shell with Angular's router already brings
  the placeholder app to about 490 kB raw; the 1 MB error ceiling stays. (`angular.json` cannot
  hold comments, so the reason lives here.)
- **The Viewer** has three layers. The kit draws and knows nothing of vf: `neat-video-tile` plays a
  `NeatTileSource` and draws its metadata on the matching frames; `neat-tile-grid` packs the tiles.
  The app connects, in `src/app/viewer/`: `vf/` (a `VfConnection` per channel, via `/api/vf/offer`),
  `settings/` (overlay settings, layout choices), `viewer-tile.ts` (joins both to a kit tile) and
  `inspector/`. The page, `src/app/pages/viewer/`, owns them while shown: channels, paging, toolbar.
- **Unit tests** use the Angular CLI's runner (Vitest); end-to-end tests use Playwright
  (`frontend/e2e`).

## The vendored kit

`@sima/neat-ui` is never published to a registry. The app depends on a versioned tarball committed
in `frontend/vendor/`, the same file the kit attaches to its GitHub release. Why: builds stay
reproducible, and CI works without a registry or cross-repo credentials while both repos are
private.

- **Commits always reference a vendored tarball**, never a path into a kit checkout, which CI and
  other machines do not have.
- **Upgrading:** copy the new release's `sima-neat-ui-<version>.tgz` into `frontend/vendor/`, run
  `npm install ./vendor/sima-neat-ui-<version>.tgz`, delete the old tarball, and commit the tarball,
  `package.json` and `package-lock.json` together. The lockfile pins the tarball's hash, so
  replacing a tarball under the same name fails `npm ci`.
- **Iterating against an unreleased kit build:** build the kit (`npm run build` in
  `~/dev/neat-next/neat-ui`), then in `frontend/` run
  `npm install ../../neat-ui/dist/neat-ui --no-save --install-links`. `--install-links` copies the
  package instead of linking it; a link would resolve the kit's dependencies from the kit
  checkout's `node_modules` and load a second copy of Angular, which fails at runtime (NG0203).
  `--no-save` leaves `package.json` and the lockfile alone, and `npm ci` returns to the vendored
  tarball.

## Commands

Node 24 is required for the frontend (`.node-version`; Angular 22 supports
`^22.22.3 || ^24.15.0`, we pin 24). Run these in `frontend/`:

| Command         | What it does                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------- |
| `npm start`     | Dev server on `http://localhost:4200`                                                               |
| `npm test`      | Unit tests (`npm test -- --watch=false` runs once and exits)                                        |
| `npm run lint`  | ESLint (angular-eslint, kit-only imports), Stylelint (no colour literals) and a typecheck of `e2e/` |
| `npm run build` | Production build into `frontend/dist`                                                               |
| `npm run e2e`   | Playwright end-to-end tests (`frontend/e2e`)                                                        |

The backend's tests run from the repo root with `python -m unittest discover -s tests`. Run lint,
the unit tests and the build before opening a PR; CI (`.github/workflows/tests.yml`) runs the same.

To try a branch in the Neat SDK container on `:9900`, use the `sima-insight-dev-deploy` skill and
run its script under Node 24 from this checkout:
`~/.local/share/fnm/fnm exec --using=24 -- ~/.claude/skills/sima-insight-dev-deploy/deploy.sh`
(`deploy.sh --restore` brings back the stock service).

## Quality bar

This is a prototype held to production standards of cleanliness, structure and tests, without
overengineering: no abstraction without a second use or a stated reason, no speculative
configurability. When a quick fix and a clean fix differ, take the clean one or stop and raise it.
