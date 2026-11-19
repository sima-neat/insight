# AGENTS.md

Guidance for anyone (human or agent) working in this repository. The rules come with their
reasons; if a reason does not apply to your situation, the escape hatch says what to do instead of
working around the rule.

## What this repo is

`insight-next` is a prototype that rebuilds the Neat Insight frontend in Angular on SiMa.ai's
UI kit, `@sima/neat-ui` (repo `justin-guth-sima/neat-ui`). Its design notes are kept outside the
repo.

- `frontend/`: the Angular app. The server embeds its build (`frontend/dist`).
- `server/`: the backend, one Go binary, which is being rewritten from scratch on
  `feat/backend-rewrite` (see "The server" below). It listens on `--port` and serves the web UI
  and the API.
- `neat_insight/`: the Python package that ships the server: the `neat-insight` command
  (`launcher.py`), which runs the server binary, and the `neat-insight-metadata-test` command
  (`tools/metadata_test.py`), the test feed below. The test feed imports nothing of the package,
  because `scripts/test-feed.sh` copies the file into the SDK container on its own.
- `webrtc/mediamtx.yml`: MediaMTX's configuration, all that is left of vf's folder (the server's
  channels replaced vf). The build copies it beside the server's binary, which renders it for
  MediaMTX at start (see "MediaMTX" below).
- `docs/`: the user docs, which developer.sima.ai publishes under `/tools/insight/`, so their file
  names and front matter stay as they are. `docs/contracts.md` is what an app follows to show up
  in Insight (source URLs, channel ports, the metadata format with its JSON Schemas in
  `docs/schemas/metadata/`). The translations in `docs/i18n/` are regenerated from the English
  pages before a release.
- `build.sh` builds the release wheels; `scripts/` holds the build and dev helpers named under
  "Commands" and the Vulcan release scripts; `media-assets/` builds the media catalog Insight
  imports from.

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

**Name an icon from the kit's set first; a glyph from `@sima/neat-ui/lucide` only where none fits.**
`neat-icon`'s `name` takes a name from `NEAT_ICON_NAMES`. Why: the kit's icon library stays
swappable, and only the glyphs you import are bundled. Never import `lucide` or `@lucide/angular`
yourself (ESLint rejects `@lucide/*`). Escape hatch: if no name fits, pass a glyph imported from
`@sima/neat-ui/lucide` (`import { Rocket } from '@sima/neat-ui/lucide'`).

**Ease with a catalog curve; a custom easing function only where none fits.**
Give `neatEased` and `NeatEasedNumber` a name from `NEAT_EASINGS` (`ease-in-out`, the default,
`ease-out`, `ease-in`, `linear`). Why: one motion language across apps. Escape hatch: if no curve
fits, pass a custom function.

**Pages live in the rail; a page's sub-pages are its rail item's `children`.**
A page with views of its own gives its `NeatNavItem` `children` (`{ label, path }`), which unfold
under it in the rail and show as a menu when the rail is collapsed; a child whose `path` equals its
page's matches only exactly. A deeper route sets its own `title`. Never use route-linked tabs (the
kit has none). Why: one place to navigate, so every address has the same place in the rail, the top
bar and the browser history. `neat-tabs` is for views inside one page that are not addresses.
Escape hatch: a level the rail cannot hold is a kit gap; raise it as a kit change.

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
  the kit's `provideNeatTitles` turns that into `Neat Insight · <Page>`. `navigation.ts` lists the
  rail items. A new page needs both, and `navigation.spec.ts` checks that they agree. The old app's
  paths keep working: `/rtsp` and `/visualizer` redirect to their pages, and `/` and unknown paths
  (old `/workspace` and `/genai` bookmarks) land on Streaming.
- **Side panels.** Viewer, Streaming, Media, Peripherals and Stats open their side panel with the
  kit's `neat-aside-toggle` ("Side panel"), declared in the page's template beside its
  `*neatPageToolbar`, never inside it (that throws in dev mode): the shell draws the button at the
  top bar's right edge, after the kiosk button, so it is not among the page's tools. A page builds
  its panel from the kit's aside parts (`neatAsidePanel`, `neatAsideTitle`, `neatAsideHeading`,
  `neatAsideActions`, `neatCode`). Whether
  a page's panel is open is remembered per page in storage: the Viewer in its layout
  (`LayoutPrefs`), Streaming, Media, Peripherals and Stats in `AsidePrefs`
  (`neat-insight:<page>:aside`). That is the wide-screen choice. The width the user dragged the
  panel to (the kit's `asideWidth`, bound on each page's `neat-page`) is remembered per page too:
  `AsidePrefs.width` as `neat-insight:<page>:aside-width`, the Viewer's `LayoutPrefs.inspectorWidth`
  as `neat-insight:viewer:aside-width`; no value is the kit's default. On a narrow screen (below
  48rem) the kit floats the panel over the page, so it starts closed there and opening or closing it
  is not remembered: each page keeps its state through the kit's `neatAsideOpen` (`AsidePrefs` for
  four pages, the Viewer's `inspector` for the fifth), and a phone never overwrites what a wide
  screen chose. The two differ in how long a phone's choice lives: on Streaming, Media, Peripherals
  and Stats an opened panel is kept for the session (`AsidePrefs` is root-provided), while the
  Viewer's inspector, owned by the page, starts closed on each visit. The panel is still
  `neat-aside-toggle`'s to close. Where the user was on a page (Viewer position, Streaming's slot
  and the source form its empty slots were left on, Media's folder and selection, Peripherals'
  device and modes, Stats' card, thermal group and runs) lives in memory for the next visit
  (`ViewerSession`, `SourcesSession`, `PeripheralsSession`, `StatsSession`).
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
  - `app-copy-command` is a command for the user to run elsewhere, with Copy: the one that
    authorizes Insight's key (in `app-board-problem-notice`), the board dialog's `ssh` command
    (Insight runs no shell of its own), and Stats' command for a missing or stopped Sentinel.
  - `app-board-settings-action` is a callout's "Open board settings"
    (`<app-board-settings-action neatCalloutActions />`), for a problem the board's settings fix;
    it opens the board dialog through `AppDialogs`. Peripherals' and Stats' notices use it.
  - `app-sentinel-failure` says why a Sentinel request failed: a danger callout, announced as an
    alert, with `failureOf`'s title, the server's message and hint, and Retry (`retry`) only
    where asking again can help; `busy` makes Retry read "Retrying…" and wait with the focus kept
    on it. Stats' Live, Runs and Compare views and the run panel use it; a board-coded failure has
    `app-board-problem-notice` instead.
  - `app/format-bytes.ts` (`formatBytes`) words every byte count in the app (media sizes, System
    Info's memory and disk), so one quantity reads the same everywhere.
  - `app/hold-focus.ts` (`holdFocus`) keeps the keyboard in place when a click removed the
    button it was on: after the next render, a focus that fell to the body moves to the element
    named (Media's panel, Stats' Runs view and Record).
  - A ⋯ menu's rows are plain `<button type="button" neatPopoverItem>`s, with a
    `hr[neatPopoverDivider]` between groups (Streaming's and Stats' menus), inside a
    `neat-popover`; there is no app component for them. They carry no `neatButton`: its classes
    fight the row look.
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
- **The top bar is the page's, the rail the app's.** The top bar carries the page's title and tools
  (`*neatPageToolbar`), then the kiosk button and the page's side-panel toggle, all the kit's: the
  app puts nothing else in it, and `neatTopbarEnd` is unused. The rail holds the pages, then at its
  bottom (`neatRailEnd`, in `app.ts`) the board block (`app-board-rail`), a `neatRailDivider`
  line, and a `neatRailItem` "System information", followed by the kit's theme item and the rail's
  own control. The board block is one `button[neatRailItem]` with the kit's state inputs: a board
  icon as its content, `tone` the state dot on it (success connected, warning checking, danger
  error, neutral not selected or not checked), `text` the short name and `detail` the address when
  connected or the state in words in the state's colour otherwise; the kit draws the dot and both
  lines, and cuts each. Its `label`, which is its accessible name and its collapsed tooltip, is one
  "name — address — state" (`boardRailView` in `board-view.ts`), so the state is in words and not
  only in colour. `AppDialogs` opens both dialogs, from the rail and from any page
  that links to them (Peripherals' "Open board settings"); each opens once at a time, and a chunk
  that cannot be loaded says so in a toast. The dialogs are imported on their first open, not with
  the rail: whatever the app root imports statically is in the initial bundle on every page, and
  the dialogs, with the kit entries only they use, would cost every first paint for something most
  visits never open.
- **The board** has one reader and writer, `BoardService` (root-provided): the rail's board block,
  the board dialog, Peripherals and Stats read its state, and its actions (select, Use default,
  Check again, trust a host key) answer with the fresh state; page code never fetches `/api/boards`
  itself. It is re-read when the window regains focus and after every action, never polled on a
  timer: `GET /api/boards` does not connect to the board, and the pages' own board traffic keeps
  its status current. The one connection check of its own is on load: the first answered read of
  an app load runs `check()` when a board is selected and its state is unknown, silently (a failure
  only lands in the state, so the board block shows Error; an answer for a board no longer
  selected is not applied). While a check is out (`checking`, Check again's too) the block says
  Checking… where it would say Not checked. Answers arrive out of order, so a read's answer is
  dropped once a newer one or an action's has been applied. Every board route names the board by
  its id (`boardUrl`, `/api/boards/{id}/...`), and a request for a board that is no longer selected
  is answered 404 `not_found`: code that holds something of a board keeps the id it asked with and
  drops what it holds when the id changes.
- **Peripherals** splits its state by how long it lives. `PeripheralsService` (root) holds the
  board's scan: the snapshot read from `GET /api/boards/{id}/peripherals` (Sentinel's catalog as
  the server answers it, made into the page's devices by `snapshotOf`), Refresh, and the scan of
  each visit (`scanOnVisit`: whenever the page is entered with a board selected, unless a camera
  preview is running then, since a scan stops it; never on a timer). A visit's scan is silent when
  it succeeds, and the preview a visit resumes starts after it, not when it failed.
  `PeripheralsSession` (root) remembers where the user left the page. `CameraPreview` and
  `MicTest` are provided by the page, so they live exactly as long as it: leaving Peripherals stops
  the camera preview (the next visit starts it again, once), and a microphone recording is left to
  finish on the board for the next visit to take up. The server runs one preview and one test per
  board, and stops them when the board is replaced; the controllers handle another tab holding
  them. A preview the page takes up (one running on entry, or one a refused Start finds) goes
  through the page's `CameraPreview.onAdopt`, which selects its camera and remembers its mode, so
  the page never leaves, and so stops, a preview it just took up.
- **Stats** has three views, each at its own address so that it can be bookmarked or shared: Live
  (`/stats`), Runs (`/stats/runs`) and Compare (`/stats/runs/compare?runs=<a>,<b>[,…]&baseline=<a>`,
  runs named by id). They are child routes without components of their own (`app.routes.ts`), so
  the page stays one instance across them, its services keep what they read, and it draws the
  view its address names; Live and Runs are Stats' children in the rail (`INSIGHT_NAV`), and
  Compare, reached from Runs, keeps Runs current and is titled "Compare". Their shared parts are listed above (`app-stats-chart`, with
  Compare's elapsed axis, `app-sentinel-failure`, the kit's table). The page splits its state by
  how long it lives, as Peripherals does. `SentinelTelemetry` and `SentinelRuns` are provided by
  the page, so they live exactly as long as it: leaving Stats stops every request to the board
  (the Sentinel health read, the metric polls, the trace and run reads), and because Sentinel
  keeps its own recent samples, coming back shows the full window at once. The metrics are polled
  only while Live shows them (`SentinelTelemetry.setWatching`). `SentinelRuns` reads nothing until
  the state says Sentinel answers (`setSentinelReady`); then it reads the trace being recorded
  every 30 s on every view, since Record and the recording line sit in each view's toolbar, and
  the run list every 30 s while Runs or Compare shows (`setRunsShown`), and at once when a trace
  read finds another trace than before; its start, stop and delete go to the board they were asked
  for, by its id, so one that outlives a board switch is refused (404 `not_found`) rather than
  made on the new board. Compare asks Sentinel for the comparison itself
  (`/api/boards/{id}/sentinel/compare`, the baseline first), once the run list says every
  run is still on the board and finished. Insight installs and starts nothing on the board: where
  Sentinel is missing or stopped, the page shows the command the error's hint names, with Copy
  (`app-copy-command`), and Check again asks once more. `StatsSession` (root) keeps the chosen
  card and thermal group, the selected and ticked runs (by id, dropped on another board) and
  Compare's series for the next visit.
  The metric history is incremental, from Sentinel's cache
  (`/api/boards/{id}/sentinel/cache`): the first poll asks for the whole cache, the next ones pass
  `after` (the newest timestamp held), and the answer holds only the newer samples. An answer
  marked `full` replaces the window instead: one comes when there is no `after`, when the cache no
  longer holds that sample (a daemon restart, a caller too far behind) and when the board's clock
  stepped back. Only Stats polls Sentinel: nothing else does, and `/api/system/host` (System
  Info's "This computer") is read on open and on Refresh only.
- **Build output.** `npm run build` writes the app to `frontend/dist` with `index.html` at its root,
  where `scripts/build-server.sh` looks for it to embed it in the server. Fonts and other media go to
  `dist/assets/` instead of Angular's default `media/`, which the old backend's `/media/<path>`
  route once shadowed (the library is `/api/media/...` now). Keep built files away from
  `/stream/`, which the server keeps for the sources' MJPEG output, and from `/static/`, which the
  hosted mode's public origin routed to vf's old page. The initial bundle measures about 606 kB
  raw, most of it the kit's shell, the toast host (rendered in the app root, so it is in main on
  purpose) and Angular with its router, plus the XHR backend (`withXhr()`, 4 kB: only XHR reports
  the upload progress of imports). Its budget in `angular.json` warns at 620 kB, a little above
  that, so growth shows up early, and the 1 MB error ceiling stays. The kit's video code is imported
  from `@sima/neat-ui/video`, only by the Viewer, so it loads with that route and stays out of the
  initial bundle. Streaming, Media, Peripherals and Stats are lazy routes too, and so are the kit
  entries only they use (`/file-browser`, `/select-list`, `/dialog`, Peripherals' `/level-meter` and
  the charts entry, `/charts`, which only Stats draws with and which brings d3's scale and shape
  modules: nothing outside Stats imports it, and a type-only import is erased). The board and System
  Info dialogs of the rail are imported on their first open (`AppDialogs`), with the kit entries
  they bring (`/collapsible`, `/callout`, which Peripherals and Stats use too).
  `npm run check:bundle` (after a build, and in CI) fails if any of that leaks into the initial
  bundle, or goes missing from the build: its markers are the selectors of the Viewer's video
  tile, the four lazy pages (`app-streaming-page`, `app-media-page`, `app-peripherals-page`,
  `app-stats-page`), the parts only Stats uses (`app-stats-runs`, `app-stats-compare`,
  `app-run-panel`, `app-record-trace`, `app-sentinel-failure`), the two dialogs
  (`app-board-dialog`, `app-system-info-dialog`) and those kit entries, the charts entry's among
  them (`neat-time-chart`, `neat-stacked-chart`, `neat-heatmap`, `neat-sparkline`,
  `neat-chart-card`) and the status chip (`neat-status-chip`: the board block draws its state
  without it, so it loads with the pages and dialogs that show one). The toast host is the kit
  entry that is there on purpose: the app root renders it. A new lazy page or dialog adds its
  selector.
- **The Viewer** has three layers. The kit (`@sima/neat-ui`, vendored in `frontend/vendor/`; the
  video part is its `@sima/neat-ui/video` entry point) draws and knows nothing of the server:
  `neat-video-tile` plays a `NeatTileSource` and draws its metadata on the matching frames;
  `neat-tile-grid` packs the tiles.
  The app connects, in `src/app/viewer/`: `vf/` (a `VfConnection` per channel, via
  `POST /api/channels/{n}/offer`; the folder keeps the old viewer's name),
  `settings/` (overlay settings, layout choices, and the regions of interest in `RoiStore`, which
  has its own storage names, `roi:global` and `roi:channel:<n>`; regions are display-only and never
  leave the browser), `viewer-tile.ts` (joins both to a kit tile), `channel-playback.ts`
  (`ChannelPlayback`: which grid tiles are playing, for the inspector's ROI backdrop) and
  `inspector/`. The page, `src/app/pages/viewer/`, owns them while shown: channels, paging, toolbar.
  Leaving it closes every connection; `viewer-session.ts` (root-provided) keeps its page and
  selection for the next visit to the same link, and its inspector tab for any.
- **Unit tests** use the Angular CLI's runner (Vitest); end-to-end tests use Playwright
  (`frontend/e2e`).

## The server

`server/` is a Go module (its `go.mod` names the Go version). `neat-insight --port 9900` (the
Python package's command, `neat_insight/launcher.py`) execs `neat_insight/bin/neat-insight` with
the same arguments.

- **The API is described first.** `server/api/openapi.yaml` is the source; `go generate ./...` in
  `server/` writes the Go types and routing (`api/api.gen.go`, oapi-codegen, a `tool` in `go.mod`),
  and CI fails when they differ. A route is added to the YAML first, then implemented. Routes
  marked Frozen there are used outside Insight (the SDK, sima-cli) and keep their paths and fields.
  Handlers answer with the generated `api.*` types where they build the answer at the web edge
  (the boards, the channels), and with a package's own types where it builds the answer (the
  slots, the library, jobs, peripherals, System Info), whose fields the domain code reads and
  writes: `internal/web/contract_test.go` sends requests to the real handlers and checks every request and
  answer against the YAML (statuses documented, no field the schema does not name), and fails
  while any operation of the YAML goes unanswered. A new route needs a call there. The server
  serves the YAML itself at `GET /api/openapi.yaml` (embedded at build time, `api.Document`), so
  agents and tools read the API from the running server.
- **Errors have one shape**, `{"error": {"code", "message", "hint"?}}`, and one type,
  `apierr.Error` (`internal/apierr`), whose optional `HostKey`, `Command`, `Conflict` and `Slots`
  go beside `error` in the answer. Every package returns it; anything else is a 500
  `internal_error` with its message. A path under `/api/` that names no route answers it with 404
  `not_found`.
- **Cross-site writes are refused.** The handler is wrapped in Go's `http.CrossOriginProtection`:
  a request that changes something (any method but GET, HEAD and OPTIONS) from a page of another
  origin is 403 `cross_origin`, by the browser's `Sec-Fetch-Site`, else its `Origin` against the
  `Host` it sent (a port map leaves that the browser's own). Requests without either (curl,
  scripts) pass, and the hosted public origin is trusted for a proxy that rewrites `Host`. So
  request bodies need no content-type check of their own.
- **Startup** (`cmd/neat-insight`): the configuration is resolved once (`internal/config`: where
  Insight runs, its data folder, the hosted-mode files sima-cli writes, the SDK's port map), then
  the certificate (`internal/certs`: the SDK's, a valid earlier one, or a new one from mkcert,
  which Insight never installs), then the channels, MediaMTX, the sources and the board
  registry; the server listens once they have started, so `/api/health` always answers `ok`.
  The programs Insight ships (`mediamtx`, its `mediamtx.yml`, `ffmpeg_nodelay.so`) are found beside
  the server's binary (`neat_insight/bin/`); ffmpeg and ffprobe on `PATH`. Shutdown runs the other
  way: the HTTP server, then the board's preview and microphone test and its connection, the
  slots' publishers and encodes, the relays and the jobs, then the children.
- **Children** run under `internal/supervisor`: each in its own process group, stopped as a group,
  restarted with back-off when it is a service, its PID in `<data>/run/` so the next start stops
  what a crashed run left behind (and only that: the PID must still run the same program and lead
  its own group).
- **Dropped, not moved:** the old Python backend's Workspace, GenAI Studio relay, profiling
  stream, YouTube import and API docs page (`/api/docs`, `/api/openapi.json`) are not in the
  server; `/api/openapi.yaml` replaces the document.
- **MediaMTX** (`internal/mediamtx`) is the server's child, restarted when it exits: its
  configuration is the shipped `mediamtx.yml` rendered into `<data>/run/` with this run's API
  password and publisher tag (readable by the owner only), and its WHIP listener serves the
  server's certificate, offers the browser ICE address and binds the port map's `webrtcWhipIce`.
  Its API (loopback 9901, the password) is the slots' only way to it.
- **Sources** (`internal/slots`, routes `/api/slots...`, `/api/renditions`, and the Frozen
  `/stream/http/srcN.mjpg`): the 48 slots `src1` to `src48`. Only what the user asked of each slot
  is kept (`<data>/sources.json`); state is derived from the publishers the supervisor runs, a
  MediaMTX snapshot a second and the jobs, and a reconcile step per slot makes the world match.
  The URLs they show take the port map's `rtsp.tcp` and `webrtcWhip` host ports and the public
  origin.
- **The media library** (`internal/media` for paths, the tree and the probe cache;
  `internal/library` for the routes' work, `/api/media...` and `/api/catalog...`): the media folder
  is `/workspace/.insight-media` in the SDK, `<data>/media` elsewhere. The slots are its
  `FileUser`, so it refuses to delete a file a slot plays and restarts the slots on a replaced one.
- **Encodes** (a slot's rendition at another frame rate, an upload the board would stream badly)
  have one rule, `media.Encode`: the published catalog's encoder settings
  (`media-assets/build_media_assets.py`), its bitrate by the picture's shorter side and rate
  (`media.VideoBitrate`), the level left to the encoder. Both run ffmpeg under the supervisor
  with `jobs.RunFFmpeg`, which follows its progress for the job.
- **MJPEG relays** (`internal/relay`): one ffmpeg per stream however many readers (a slot's
  preview, a slot's HTTP MJPEG output, a file's preview), capped, stopped a few seconds after the
  last reader, ended when it stalls. **Jobs** (`internal/jobs`, `/api/jobs/{id}/events`):
  renditions' encodes, uploads' re-encodes and catalog downloads, with progress as Server-Sent
  Events; the routes that start one answer with it.
- **The board** (`internal/board`, routes `/api/boards...`): one selected board, the one entered
  (`<data>/board-target.json`), else the board Insight runs on, else the DevKit the SDK is paired
  with (`DEVKIT_SYNC_DEVKIT_*`), resolved at start and on a change. Its id (`local`,
  `ssh:sima@192.168.1.20:22`) names it in every board path, so a request for a replaced board is
  404 `not_found`. One SSH connection per board, keys only (the service account's `~/.ssh`, no
  agent, no password), host keys pinned in Insight's own `<data>/known_hosts` with an explicit
  trust of a new one; Sentinel is reached through that connection's Unix-socket forwarding, so
  nothing starts on the board per request. On a board, the same operations run locally. There is
  no shell: the boards answer carries the `ssh` command line. Board failures answer the error
  shape with `host_key` (both fingerprints) or `command` (the one that authorizes the key).
- **Sentinel** (`internal/sentinel`, `/api/boards/{id}/sentinel/...`) is an allowlisted proxy:
  health (with the service's start from systemd), the cache, the active trace, traces started
  and stopped, runs listed, read and compared (with their samples), answered as
  Sentinel answers them without its schema marker; Insight keeps no telemetry. The Live view's
  history is Sentinel's own `/v1/cache`: `after` (the newest sample held) answers only newer ones
  with `full: false`, else all of them with `full: true`. A run is deleted with Sentinel's CLI
  (`simaai-sentinel runs delete`), its id checked against Sentinel's id form first and passed as
  one argument. A missing socket is told apart (not installed, stopped) by `systemctl`; the
  answer gives the command (`sima-cli neat install sentinel`), Insight installs nothing.
- **Peripherals** (`internal/peripherals`): Sentinel's peripheral catalog, kept as the board's
  last scan with what changed, its camera verdicts Sentinel's own; a camera preview (a GStreamer
  pipeline on the board over `board.Stream`, its multipart JPEG read with the relay's reader and
  relayed to one viewer, stopped with its viewer, unclaimed for 15 s or stalled); a microphone
  test (`arecord` of the device the scan names, its live level, the WAV in memory). One scan,
  preview and test per board, dropped when the board changes. Tests reach a board through
  `internal/board/boardtest`: the local board, with the test's scripts for the board's programs
  and its own Sentinel on a socket.
- **System Info** (`internal/system`, `/api/system`, `/api/system/host`): Insight's version and
  build and what it resolved at start, plus an allowlist of `neat --json`'s fields (never its code
  UI section or passwords), run once at start and on `?refresh=true`; the host's CPU (two samples
  of /proc/stat, never blocking), memory and the data folder's disk.
- **Channels** (`internal/channels`) are the Viewer's path, which replaced vf: each binds UDP
  9000+N (RTP) and 9100+N (metadata), assembles whole pictures (vf's rules: start flags, sequence
  breaks, the H.265 gate), rewrites their sequence and timestamps onto one outgoing clock, matches
  metadata to frames by the contract's rule (`docs/contracts.md`), and sends both to the browsers
  watching over WebRTC (Pion; one shared track per channel and codec, NACKs answered). Routes:
  `/api/channels` (which channels receive video, for the Viewer's Hide empty), `POST
  /api/channels/{n}/offer`, and the frozen `/api/ingest/stats` (what arrives and what was sent on,
  the counters only it reads) and `/api/viewer-url`. The count and the WebRTC port range come from the SDK's port map, read once.
  The connection tests need a network interface besides loopback (Pion gathers no loopback
  candidates), so they fail inside a network sandbox.

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
| `npm run check:bundle` | Checks the built bundle: video, lazy pages and the two dialogs stay out of the initial one          |
| `npm run e2e`          | Playwright end-to-end tests (`frontend/e2e`)                                                        |
| `npm run api:types`    | Generates `src/app/api.generated.ts` from `server/api/openapi.yaml` (`check:api`, in lint, checks)  |

The server's checks run in `server/`: `gofmt -l .`, `go vet ./...`, `go test -race ./...`, and
`go generate ./...` after a change to `api/openapi.yaml`. The tests against a real MediaMTX run
when `NEAT_INSIGHT_MEDIAMTX` names its program (CI downloads it), and skip otherwise. The
scripts' tests (the media assets, the test feed) run from the repo root with
`python -m unittest discover -s tests`. Run lint, the unit tests and the build before opening a
PR; CI (`.github/workflows/tests.yml`) runs the same.

**Building the wheel.** `./build.sh` builds the frontend, then for each target the server with
the frontend embedded (`scripts/build-server.sh`), downloads MediaMTX, builds the Linux wheels'
`LD_PRELOAD` shim (`tools/ffmpeg_nodelay.c`, which keeps the RTSP publishers' TCP sockets free of
Nagle delay) and writes the wheel to `dist/`. It needs Python 3.10+ with setuptools and wheel,
Node 24, Go (`server/go.mod` names the version; Go fetches that toolchain itself unless
`GOTOOLCHAIN=local`), and a C compiler per Linux target (`gcc`, or `gcc-aarch64-linux-gnu` and
`gcc-x86-64-linux-gnu` to cross-build). Options: `--target-platform
<host|all|linux-aarch64|linux-amd64|macos-arm64>`, `--skip-frontend`, `--skip-shim`, and
`--install` into the active virtualenv. The release workflows call it per platform, so it never
prompts.

**Trying a branch in the Neat SDK container** on `:9900`: `scripts/deploy-sdk-dev.sh`, run from
this checkout with Node 24 and Go on `PATH`, builds the frontend and the server for the container,
syncs the checkout to the dev copy `~/workspace/.insight-dev` (the container's
`/workspace/.insight-dev`), stops the stock service and starts the dev build (`--no-frontend` skips
the frontend build, `--restore` brings back the stock service). It never touches
`/opt/neat-insight`. The dev copy is made once, with MediaMTX in its `neat_insight/bin/` and its
own virtualenv:

```bash
C=$(docker ps --format '{{.Names}}' | grep -m1 sima-neat-sdk)
./build.sh
rsync -a --exclude .git --exclude node_modules ./ ~/workspace/.insight-dev/
docker exec "$C" bash -c 'cd /workspace/.insight-dev && python3 -m venv .venv && .venv/bin/pip install -e .'
```

A deploy restarts MediaMTX, so external publishers (a webcam, a test feed) start again; reload the
browser tab. The `sima-insight-dev-deploy` skill's own `deploy.sh` predates the server and does not
build it.

**The test feed.** `scripts/test-feed.sh <channel>` runs `neat_insight/tools/metadata_test.py` (the
`neat-insight-metadata-test` command) in the SDK container: a test pattern on `9000+N` and metadata
matched to its frames on `9100+N`, until Ctrl-C; options after the channel go to the feed
(`--types`, `--metadata-delay-ms`), and `scripts/test-feed.sh stop [<channel>]` stops it from
another terminal. Keep it off channels a real pipeline feeds.

**End-to-end tests against a deployed build:** `INSIGHT_BASE_URL=https://127.0.0.1:9900 npm run
e2e`. They then record no screenshots, videos or traces. The Viewer's playback tests run only this
way, with the test feed on channel 0; one of them restarts the feed detached, so
`scripts/test-feed.sh stop 0` ends it afterwards. The first run needs Chromium with its system libraries:
`npx playwright install --with-deps chromium`.

## Quality bar

This is a prototype held to production standards of cleanliness, structure and tests, without
overengineering: no abstraction without a second use or a stated reason, no speculative
configurability. When a quick fix and a clean fix differ, take the clean one or stop and raise it.
