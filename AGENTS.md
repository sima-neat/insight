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

Import each component from its own entry point: the primary `@sima/neat-ui` holds the theme, icons,
shell, page, kiosk, buttons, tooltip and note; everything else has a `@sima/neat-ui/<name>` entry
(the kit's `AGENTS.md` lists them). Why: the main bundle then carries only the entries the shell
and the app root import. The compiler rejects a name imported from the wrong entry. Never import a
name starting with `ɵ`: those are shared internals the kit exports only for its own entries, with
no stability promise, and ESLint rejects them. Escape hatch: if you need one, propose a kit change.

**If nothing fits, stop and propose a kit change instead of working around it.**
A kit change is a new component or a new input on an existing one. Why: a workaround here is
invisible to the other apps on the kit and hardens into a divergent fork; a kit change is reviewed
once and benefits every app. Escape hatch: write the proposal (what you need, why the existing
components fall short, the API you would like) and raise it with the maintainer before building; do
not ship the workaround in the meantime.

**A styled pattern lives in one place.**
App-specific markup and its styling may stay inline in the component that uses it while it has one
use. The second use turns it into a shared component: an app component if it knows Insight's data,
a kit proposal (previous rule) if it does not. Why: copies of styled markup drift apart, and a fix
to one copy silently misses the others. Escape hatch: none; copying now and extracting later is
the failure this rule exists to prevent.

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
- **Side panels.** Viewer, Streaming, Media, Peripherals and Stats open their side panel with the
  kit's `neat-aside-toggle` ("Side panel") and build it from the kit's aside parts
  (`neatAsidePanel`, `neatAsideTitle`, `neatAsideHeading`, `neatAsideActions`, `neatCode`). Whether
  a page's panel is open is remembered per page in storage: the Viewer in its layout
  (`LayoutPrefs`), Streaming, Media, Peripherals and Stats in `AsidePrefs`
  (`neat-insight:<page>:aside`). That is the wide-screen choice. On a narrow screen (below 48rem)
  the kit floats the panel over the page, so it starts closed there and opening or closing it is
  not remembered: each page keeps its state through the kit's `neatAsideOpen` (`AsidePrefs` for
  four pages, the Viewer's `inspector` for the fifth), and a phone never overwrites what a wide
  screen chose. The two differ in how long a phone's choice lives: on Streaming, Media,
  Peripherals and Stats an opened panel is kept for the session (`AsidePrefs` is root-provided),
  while the Viewer's inspector, owned by the page, starts closed on each visit. The panel is still
  `neat-aside-toggle`'s to close. Where the user was on a page (Viewer position, Streaming's slot,
  Media's folder and selection, Peripherals' device and modes, Stats' card and thermal group)
  lives in memory for the next visit (`ViewerSession`, `SourcesSession`, `PeripheralsSession`,
  `StatsSession`).
- **Shared app components.** Each is a styled pattern with more than one use (the one-place rule
  above), so use it instead of writing the markup again:
  - `app-list-column` lays out a list page's main column for `neat-page scroll="none"`: what
    stands above the list (a notice, banners) takes the height it needs and the list scrolls its
    rows in the rest. Streaming's and Media's list sits in `app-slots-column`, which adds their
    stale-status notice; Peripherals puts its banners there.
  - `app-announcement` is a status line said to screen readers and never shown (`role="status"`),
    for news the screen already shows another way. It applies the global `visually-hidden` class,
    the app's one copy of the `sr-only` rule (`frontend/src/styles.css`): the app has no Tailwind,
    so the kit's utility does not reach it. Hide anything else from the eye only with that class.
  - `app-panel-title` opens a side panel: the subject as its heading (`neatAsideTitle`) with its
    optional state chip beside it (Streaming's slot panel, Peripherals' device panels, Stats'
    areas; a null chip leaves it out). It is parked for a kit change: `neatAsideTitle` gaining a
    chip slot would replace it.
  - `app-stats-chart` is one metric's time chart (`neat-time-chart`) from the inputs a builder in
    `stats/telemetry.ts` (or Compare's overlay in `stats/compare.ts`) made, its values worded in
    the chart's unit. Every Stats time chart, in the cards, in each area and in Compare (whose
    time axis counts from the runs' start, `axis="elapsed"`), is this one, so none words a value
    or sets a scale of its own. The other Stats charts are the kit's, used directly: Power rails'
    `neat-stacked-chart`, the per-core `neat-heatmap` and the tables' `neat-sparkline`; the Power
    tiles are `neat-chart-card`.
  - `app-metrics-table` lists metrics as a table (name, group, value, a sparkline of the window,
    status): Stats' All metrics and its Storage & Network area.
  - `app-board-problem-notice` says why the board cannot be used, with the way out where there is
    one: `auth_failed`'s `ssh-copy-id` command with Copy, `host_key_changed`'s fingerprints with
    Trust new key… (which asks first), and the caller's own actions (Retry, Open board settings).
    The board dialog, Peripherals and Stats use it.
  - `app-board-settings-action` is a callout's "Open board settings"
    (`<app-board-settings-action neatCalloutActions />`), for a problem the board's settings fix;
    it opens the board dialog through `TopBarDialogs`. Peripherals' and Stats' notices use it.
  - `app/format-bytes.ts` (`formatBytes`) words every byte count in the app (media sizes, System
    Info's memory and disk), so one quantity reads the same everywhere.
  - A ⋯ menu's items are the kit's `neatPopoverItem` on a `neatButton` (Streaming's and Stats'
    menus), inside a `neat-popover`; there is no app component for them.
- **Key/value lists** use the kit's `neatDetails`. Lists that should start their values in one
  column but cannot share a grid (System Info's sections open and close on their own) set the
  kit's `--neat-details-term-width` on a common ancestor rather than restyling the list's grid
  from app CSS.
- **Data tables** use the kit's `table[neatTable]`: Stats' metrics table and run panel, and the
  comparison tables. A figure column's heading and cells take `neatNumeric` (end-aligned, one
  line, tabular digits), or `neatFigure` (the same, start-aligned) where a cell holds something
  after its figure, as the run panel's maximum holds its status chip. A table's cell padding,
  rules, heading look and text size are the kit's, so none restates them; what is one table's own
  (the metrics table's narrow-container rule and dropped group column, the run panel's flush
  edges and group headings) is plain CSS in its component, which overrides the kit's defaults
  without a heavier selector.
- **The top bar** carries the page's title and tools, then its end items (`neatTopbarEnd`) on
  every page: the board pill (`app-board-pill`), which names the board Insight uses and its state
  and opens the board dialog, and System Info's ⓘ. `TopBarDialogs` opens both dialogs, from there
  and from any page that links to them (Peripherals' "Open board settings"); each opens once at a
  time, and a chunk that cannot be loaded says so in a toast. The dialogs are imported on their
  first open, not with the top bar: whatever the top bar imports statically is in the initial
  bundle on every page, and the dialogs, with the kit entries only they use, would cost every first
  paint for something most visits never open.
- **The board** has one reader and writer, `BoardService` (root-provided): the pill, the board
  dialog, Peripherals and Stats read its state, and its actions (select, Check again,
  trust a host key) answer with the fresh state; page code never fetches `/api/board` itself. It is
  re-read when the window regains focus and after every action, never polled on a timer:
  `GET /api/board` does not connect to the board, and the pages' own board traffic keeps its
  status current. Answers arrive out of order, so a stale one is dropped; every response that
  describes the board carries its `generation`, and an answer for another generation is never
  applied.
- **Peripherals** splits its state by how long it lives. `PeripheralsService` (root) holds the
  board's scan: the snapshot read from `GET /api/peripherals`, Refresh, and the automatic first
  scan, which runs once per board generation in an app session rather than on every visit.
  `PeripheralsSession` (root) remembers where the user left the page. `CameraPreview` and
  `MicTest` are provided by the page, so they live exactly as long as it: leaving Peripherals stops
  the camera preview (the next visit starts it again, once), and a microphone recording is left to
  finish on the board for the next visit to take up. The backend runs one preview and one test per
  Insight; the controllers handle another tab holding them. A preview the page takes up (one
  running on entry, or one a refused Start finds) goes through the page's `CameraPreview.onAdopt`,
  which selects its camera and remembers its mode, so the page never leaves, and so stops, a
  preview it just took up.
- **Stats** splits its state by how long it lives, as Peripherals does. `SentinelTelemetry` is
  provided by the page, so it lives exactly as long as it: leaving Stats stops every request to the
  board (the state read, the metric polls), and because the backend holds the history, coming back
  shows the full window at once. `SentinelInstall` is root-provided, so an install (which takes
  minutes) outlives the page: leaving Stats and coming back still finds it running, and its toast
  says when it ended. `StatsSession` (root) keeps the chosen card and thermal group for the next
  visit. The history is incremental: the first poll asks for the window (`history=240`), the next
  ones pass `after` (the newest timestamp held) and `epoch` (which history it is of), and the
  answer holds only the newer samples. An answer marked `full` replaces the window instead. The
  backend sends one for a first poll (no `after`); when its history restarted, so the `epoch`
  named is not its current one (another board, a daemon restart, a polling gap, a clock step, or
  a reseed that added earlier samples); when it no longer holds the `after` sample; and when more
  samples came after it than `history` allows. Only Stats polls Sentinel: nothing else does, and
  `/api/metrics` (System Info's "This computer") is read on open and on Refresh only.
- **Build output.** `npm run build` writes the app to `frontend/dist` with `index.html` at its root,
  where Flask (`_resolve_frontend_dist`) and `build.sh` look for it. Fonts and other media go to
  `dist/assets/` instead of Angular's default `media/`: Flask's `/media/<path>` route serves
  Insight's media library and would shadow them. Keep built files away from `/media/` and from
  `/static/`, which the hosted mode's public origin routes to vf. The initial-bundle budget warns
  at 600 kB. The initial bundle measures 571.4 kB raw with kit 0.14.1 (the shared chunk 457 kB,
  main 20 kB, styles 94 kB; 571.3 kB with kit 0.14.0; 569.7 kB with kit 0.13.0; 569.4 kB with kit
  0.12.2; 569.1 kB with kit 0.12.1; 568.8 kB with kit 0.12.0; 691.9 kB with kit 0.11.3 and 0.11.2,
  before the icons became plain Lucide drawings; 691.7 kB with kit 0.11.1;
  691.5 kB with kit 0.11.0; 684.7 kB with kit 0.10.3; 672 kB with kit 0.10.0 before the board pill
  and System Info's button; 650 kB with kit 0.9.0;
  694 kB with kit 0.5.3, before the kit split into per-component entries), most of it the kit's
  shell, the toast host (rendered in the app root, so it is in main on purpose) and Angular with
  its router, plus the XHR backend (`withXhr()`, 4 kB: only XHR reports the upload progress of
  imports); the warning sits about 30 kB above that, so growth shows up early, and the 1 MB error
  ceiling stays. (`angular.json` cannot hold comments, so the reason lives here.) The kit's video
  code is imported from `@sima/neat-ui/video`, only by the Viewer, so it loads with that route and
  stays out of the initial bundle. Streaming, Media, Peripherals and Stats are lazy routes too, and
  so are the kit entries only they use (`/file-browser`, `/select-list`, `/dialog`, Peripherals'
  `/level-meter` and the charts entry, `/charts`, which only Stats draws with and which brings d3's
  scale and shape modules: nothing outside Stats imports it, and a type-only import is erased). The
  top bar's board and System Info dialogs are imported on their first open (`TopBarDialogs`), with
  the kit entries they bring (`/collapsible`, `/callout`, which Peripherals and the Viewer use
  too).
  `npm run check:bundle` (after a build, and in CI) fails if any of that leaks into the initial
  bundle, or goes missing from the build: its markers are the selectors of the Viewer's video tile,
  the four lazy pages (`app-streaming-page`, `app-media-page`, `app-peripherals-page`,
  `app-stats-page`), the two dialogs (`app-board-dialog`, `app-system-info-dialog`) and those kit
  entries, the charts entry's among them (`neat-time-chart`, `neat-stacked-chart`,
  `neat-heatmap`, `neat-sparkline`, `neat-chart-card`). The toast host and
  the status chip are the kit entries that are there on purpose: the app root renders the toast
  host, and the board pill shows its state in a status chip on every page. A new lazy page or
  dialog adds its selector.
- **The Viewer** has three layers. The kit (`@sima/neat-ui`, vendored in `frontend/vendor/`; the
  video part is its `@sima/neat-ui/video` entry point) draws and knows nothing of vf:
  `neat-video-tile` plays a `NeatTileSource` and draws its metadata on the matching frames;
  `neat-tile-grid` packs the tiles.
  The app connects, in `src/app/viewer/`: `vf/` (a `VfConnection` per channel, via `/api/vf/offer`),
  `settings/` (overlay settings, layout choices, and the regions of interest in `RoiStore`, which
  has its own storage names, `roi:global` and `roi:channel:<n>`; regions are display-only and never
  leave the browser), `viewer-tile.ts` (joins both to a kit tile), `channel-playback.ts`
  (`ChannelPlayback`: which grid tiles are playing, for the inspector's ROI backdrop) and
  `inspector/`. The page, `src/app/pages/viewer/`, owns them while shown: channels, paging, toolbar.
  Leaving it closes every connection; `viewer-session.ts` (root-provided) keeps its page and
  selection for the next visit to the same link, and its inspector tab for any.
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

| Command                | What it does                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `npm start`            | Dev server on `http://localhost:4200`                                                               |
| `npm test`             | Unit tests (`npm test -- --watch=false` runs once and exits)                                        |
| `npm run lint`         | ESLint (angular-eslint, kit-only imports), Stylelint (no colour literals) and a typecheck of `e2e/` |
| `npm run build`        | Production build into `frontend/dist`                                                               |
| `npm run check:bundle` | Checks the built bundle: the video code, lazy pages and top-bar dialogs stay out of the initial one |
| `npm run e2e`          | Playwright end-to-end tests (`frontend/e2e`)                                                        |

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
