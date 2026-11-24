# AGENTS.md

Guidance for anyone (human or agent) working in this repository. The rules come with their
reasons; if a reason does not apply to your situation, the escape hatch says what to do instead of
working around the rule.

## What this repo is

Neat Insight is SiMa.ai's browser tool for developing Neat vision apps: an Angular frontend on
SiMa.ai's UI kit, `@sima/neat-ui`, and a Go server.

- `frontend/`: the Angular app. The server embeds its build (`frontend/dist`).
- `server/`: the backend, one Go binary. It listens on `--port` and serves the web UI and the API.
- `neat_insight/`: the Python package that ships the server: the `neat-insight` command
  (`launcher.py`), which execs the server binary (`neat_insight/bin/neat-insight`) with the same
  arguments, and the `neat-insight-metadata-test` command (`tools/metadata_test.py`), the test
  feed below. The test feed imports nothing of the package, because `scripts/test-feed.sh` copies
  the file into the SDK container on its own.
- `webrtc/mediamtx.yml`: MediaMTX's configuration. The build copies it beside the server's binary,
  which renders it for MediaMTX at start.
- `docs/`: the user docs, which developer.sima.ai publishes under `/tools/insight/`, so their file
  names and front matter stay as they are. [docs/contracts.md](docs/contracts.md) is what an app
  follows to show up in Insight (source URLs, channel ports, the metadata format with its JSON
  Schemas in `docs/schemas/metadata/`). The translations in `docs/i18n/` are regenerated from the
  English pages before a release.
- `build.sh` builds the release wheels; `scripts/` holds the build and dev helpers named under
  "Commands" and the Vulcan release scripts; `media-assets/` builds the media catalog Insight
  imports from.

## Rules for the frontend

The app follows the kit's rules for apps, which this file does not repeat: read them before
writing UI. They are "Using the kit in an app" in the kit's package README
(`frontend/node_modules/@sima/neat-ui/README.md`, after `npm ci`) and, for every component and with
the reasons, the `AGENTS.md` of the kit's own repository. In short: UI only from the kit, each part from its own
entry point, never a `ɵ` name, icons and easings from the kit's catalogs, navigation through the
rail and its `children` (never route-linked tabs), styling only through theme tokens and component
inputs, each page in `neat-page` owning at most one scroll context, and raw browser APIs (WebRTC,
video, canvas, Web Audio) in small tested units outside change detection. The kit's showcase
(`npm start` in the kit) shows every component in both themes and is the first place to look
before building something.

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
the failure this rule exists to prevent. The shared components and helpers are the files at the
top of `frontend/src/app/` and in its `board/`, `sources/` and `pages/stats/` folders: look there
before writing markup or a formatter again.

**Component styles live in a `.css` file next to the component, referenced with `styleUrl`, and
never `@import` anything.**
Why: Stylelint reads only stylesheets, so a style written inline in the decorator (`styles:`) would
escape its rule against color literals (hex, `rgb()`, `hsl()`); ESLint rejects inline styles
(templates may stay inline). The kit stylesheet reaches the app once, through `angular.json`; an
`@import` in a component (of `tailwindcss`, `tw-animate-css` or the kit stylesheet) would pull a
second copy of styles into it, so Stylelint rejects `@import`. Escape hatch: none; a component that
needs no styles has no stylesheet.

**The app has no Tailwind of its own.** Utility classes in app templates do nothing reliable, and
the kit's `sr-only` does not reach the app: hide something from the eye only with the global
`visually-hidden` class (`frontend/src/styles.css`), the app's one copy of that rule.
`app-announcement` uses it for a status line said to screen readers and never shown.

ESLint also rejects imports of the libraries under the kit (Spartan, Lucide, d3, Tailwind's class
helpers, and PrimeNG, which the kit replaced) and of `ɵ` names; the compiler rejects a name
imported from the wrong entry point.

## How the frontend is put together

- **Pages are routes.** `app.routes.ts` loads each page lazily and titles it with its rail label;
  `navigation.ts` lists the rail items. A new page needs both, and `navigation.spec.ts` checks that
  they agree. `/` and unknown paths land on Streaming.
- **State lives as long as it should.** What a page runs is provided by the page, so it stops when
  the page is left: the Viewer's connections, Peripherals' `CameraPreview` and `MicTest`, Stats'
  `SentinelTelemetry` and `SentinelRuns` (leaving Stats stops every request to the board). Where
  the user was on a page lives in a root-provided session service for the next visit
  (`ViewerSession`, `SourcesSession`, `PeripheralsSession`, `StatsSession`), and whether its side
  panel is open and how wide is kept in storage per page (`AsidePrefs`, the Viewer's
  `LayoutPrefs`).
- **The board** has one reader and writer, `BoardService` (root-provided); page code never reads
  `/api/boards` itself. It is re-read when the window regains focus and after every action, never
  polled on a timer: `GET /api/boards` does not connect to the board, and the pages' own board
  traffic keeps its status current. Its one connection check of its own is the first read of an
  app load, when a board is selected and its state is unknown. Answers arrive out of order, so a
  read's answer is dropped once a newer one or an action's has been applied. Every board route
  names the board by its id (`boardUrl`, `/api/boards/{id}/...`), and a request for a board that
  is no longer selected is answered 404 `not_found`: code that holds something of a board keeps
  the id it asked with and drops what it holds when the id changes.
- **Peripherals** scans the board on every visit, never on a timer, but not while a camera preview
  runs, since a scan stops it. The server runs one preview and one test per board, and another tab
  may hold them: a preview the page takes up goes through `CameraPreview.onAdopt`, so the page
  never leaves, and so stops, a preview it just took up.
- **Stats** has three views, Live, Runs and Compare, each at its own address so that it can be
  bookmarked or shared. They are child routes without components of their own, so the page stays
  one instance across them and its services keep what they read. Only Stats polls
  Sentinel, and only for what its view shows (`SentinelTelemetry.setWatching`,
  `SentinelRuns.setRunsShown`); System Info's `/api/system/host` is read on open and on Refresh
  only. Insight installs and starts nothing on the board: where Sentinel is missing or stopped,
  the page shows the command the error's hint names.
- **The Viewer.** The kit's video entry (`neat-video-tile`, `neat-tile-grid`) draws and knows
  nothing of the server. The app connects it in `src/app/viewer/` (`vf/`, named after the old
  viewer, holds a channel's WebRTC connection), and the page, `src/app/pages/viewer/`, owns the
  connections while it is shown. Regions of interest are display-only and never leave the browser.
- **The initial bundle** carries whatever the app root imports statically, on every page. So the
  Viewer's video code, the Streaming, Media, Peripherals and Stats pages, the kit entries only they
  use (`@sima/neat-ui/charts`, with d3, only in Stats) and the rail's board and System Info dialogs
  (imported on their first open, through `AppDialogs`) stay out of it; the toast host is in it on
  purpose, since the app root renders it. `npm run check:bundle` fails when any of that leaks into
  the initial bundle or goes missing from the build; a new lazy page or dialog adds its selector to
  the markers in `frontend/scripts/check-bundle-split.mjs`. The initial budget in `angular.json`
  warns a little above the current size, so growth shows up early.
- **Build output.** `npm run build` writes the app to `frontend/dist` with `index.html` at its
  root, where `scripts/build-server.sh` looks for it to embed it in the server. Keep built files
  away from `/stream/`, which the server keeps for the sources' MJPEG output.

## The server

`server/` is a Go module (its `go.mod` names the Go version).

- **The API is described first.** `server/api/openapi.yaml` is the source of both sides: in
  `server/`, `go generate ./...` writes the Go types and routing (`api/api.gen.go`, oapi-codegen, a
  `tool` in `go.mod`); in `frontend/`, `npm run api:types` writes `src/app/api.generated.ts`. Never
  edit either by hand: CI fails when the Go code differs from the YAML, and `check:api` (part of
  `npm run lint`) when the TypeScript does. A route is added to the YAML first, then implemented.
  Routes marked Frozen there are used outside Insight (the SDK, sima-cli) and keep their paths and
  fields. Handlers answer with the generated `api.*` types where they build the answer at the web
  edge (the boards, the channels), and with a package's own types where the package builds it;
  `internal/web/contract_test.go` sends requests to the real handlers and checks every request and
  answer against the YAML (statuses documented, no field the schema does not name), and fails
  while any operation of the YAML goes unanswered, so a new route needs a call there. The server
  serves the YAML at `GET /api/openapi.yaml`.
- **Errors have one shape**, `{"error": {"code", "message", "hint"?}}`, and one type,
  `apierr.Error` (`internal/apierr`), whose optional `HostKey`, `Command`, `Conflict` and `Slots`
  go beside `error` in the answer. Every package returns it; anything else is a 500
  `internal_error` with its message. A path under `/api/` that names no route answers 404
  `not_found`.
- **Cross-site writes are refused.** The handler is wrapped in Go's `http.CrossOriginProtection`:
  a request that changes something (any method but GET, HEAD and OPTIONS) from a page of another
  origin is 403 `cross_origin`, by the browser's `Sec-Fetch-Site`, else its `Origin` against the
  `Host` it sent. Requests without either (curl, scripts) pass, and the hosted public origin is
  trusted for a proxy that rewrites `Host`. So request bodies need no content-type check of their
  own.
- **Startup** (`cmd/neat-insight`) resolves the configuration once (`internal/config`), then the
  certificate (`internal/certs`: the SDK's, a valid earlier one, or a new one from mkcert, which
  Insight never installs), then starts the channels, MediaMTX, the sources and the board registry;
  the server listens only once they have started, so `/api/health` always answers `ok`. Shutdown
  runs the other way. The programs Insight ships (`mediamtx`, its `mediamtx.yml`,
  `ffmpeg_nodelay.so`) are found beside the server's binary; ffmpeg and ffprobe on `PATH`.
- **Children** run under `internal/supervisor`: each in its own process group, stopped as a group,
  restarted with back-off when it is a service, its PID in `<data>/run/` so the next start stops
  what a crashed run left behind (and only that: the PID must still run the same program and lead
  its own group). MediaMTX is one; its configuration is rendered into `<data>/run/` with this run's
  API password, and its API (loopback 9901, with that password) is the slots' only way to it.
- **The rest of `internal/` is one package per area.** What is not plain from the code:
  - `slots` (the 48 sources `src1` to `src48`): only what the user asked of each slot is kept
    (`<data>/sources.json`); state is derived from the publishers the supervisor runs, a MediaMTX
    snapshot a second and the jobs, and a reconcile step per slot makes the world match.
  - `media` has the one encoding rule, `media.Encode`, for a slot's rendition and an upload's
    re-encode alike: the published catalog's encoder settings
    (`media-assets/build_media_assets.py`), its bitrate by the picture's shorter side and rate
    (`media.VideoBitrate`), run with `jobs.RunFFmpeg`.
  - `relay` runs one ffmpeg per MJPEG stream however many readers.
  - `board`: one selected board, one SSH connection per board, keys only (the service account's
    `~/.ssh`, no agent, no password), host keys pinned in Insight's own `<data>/known_hosts` with
    an explicit trust of a new one. Sentinel is reached through that connection's Unix-socket
    forwarding, so nothing starts on the board per request. There is no shell: the boards answer
    carries the `ssh` command line. Tests reach a board through `internal/board/boardtest`: the
    local board, with the test's scripts for the board's programs and its own Sentinel on a
    socket.
  - `sentinel` is an allowlisted proxy; Insight keeps no telemetry and installs nothing (a missing
    Sentinel's answer names `sima-cli neat install sentinel`). The Live view's history is
    Sentinel's own cache: `after` (the newest sample held) answers only newer samples with
    `full: false`, else all of them with `full: true`. A run id is checked against Sentinel's id
    form before it is passed, as one argument, to `simaai-sentinel runs delete`.
  - `system` passes on an allowlist of `neat --json`'s fields, never its code UI section or
    passwords.
  - `channels` is the Viewer's path: UDP 9000+N (RTP) and 9100+N (metadata) in, WebRTC (Pion) out,
    metadata matched to frames by the contract's rule
    ([Matching a message to its frame](docs/contracts.md#matching-a-message-to-its-frame)). Its
    connection tests need a network interface besides loopback (Pion gathers no loopback
    candidates), so they fail inside a network sandbox.

## The vendored kit

`@sima/neat-ui` is never published to a registry. The app depends on a versioned tarball committed
in `frontend/vendor/`, the same file the kit attaches to its GitHub release. Why: builds stay
reproducible, and CI works without a registry or cross-repo credentials.

- **Commits always reference a vendored tarball**, never a path into a kit checkout, which CI and
  other machines do not have.
- **Upgrading:** copy the new release's `sima-neat-ui-<version>.tgz` into `frontend/vendor/`, run
  `npm install ./vendor/sima-neat-ui-<version>.tgz`, delete the old tarball, and commit the tarball,
  `package.json` and `package-lock.json` together. The lockfile pins the tarball's hash, so
  replacing a tarball under the same name fails `npm ci`.
- **Iterating against an unreleased kit build:** build the kit (`npm run build` in a `neat-ui`
  checkout beside this one), then in `frontend/` run
  `npm install ../../neat-ui/dist/neat-ui --no-save --install-links`. `--install-links` copies the
  package instead of linking it; a link would resolve the kit's dependencies from the kit
  checkout's `node_modules` and load a second copy of Angular, which fails at runtime (NG0203).
  `--no-save` leaves `package.json` and the lockfile alone, and `npm ci` returns to the vendored
  tarball.

## Commands

Node 24 is required for the frontend (`.node-version`). Run these in `frontend/`:

| Command                | What it does                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `npm start`            | Dev server on `http://localhost:4200`                                                            |
| `npm test`             | Unit tests, Vitest (`npm test -- --watch=false` runs once and exits)                             |
| `npm run lint`         | `check:api`, ESLint, Stylelint and a typecheck of `e2e/`                                         |
| `npm run build`        | Production build into `frontend/dist`                                                            |
| `npm run check:bundle` | Checks the built bundle: the lazy code stays out of the initial one                              |
| `npm run e2e`          | Playwright end-to-end tests (`frontend/e2e`)                                                     |
| `npm run api:types`    | Generates `src/app/api.generated.ts` from `server/api/openapi.yaml` (`check:api` only checks it) |

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
Node 24, Go (Go fetches the toolchain `server/go.mod` names unless `GOTOOLCHAIN=local`), and a C
compiler per Linux target (`gcc`, or `gcc-aarch64-linux-gnu` and `gcc-x86-64-linux-gnu` to
cross-build). Options: `--target-platform <host|all|linux-aarch64|linux-amd64|macos-arm64>`,
`--skip-frontend`, `--skip-shim`, and `--install` into the active virtualenv. It never prompts, so
a workflow can call it per platform. The wheel carries `THIRD_PARTY_NOTICES` (the licenses of the
Go modules linked into the server) and MediaMTX's own license: after a change to `server/go.mod`,
`scripts/third-party-notices.py` writes the file again, and CI fails while it is stale. A new
MediaMTX version takes its archives' SHA-256 beside `MTX_VERSION` in `build.sh`.

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
browser tab.

**The test feed.** `scripts/test-feed.sh <channel>` runs `neat_insight/tools/metadata_test.py` (the
`neat-insight-metadata-test` command) in the SDK container: a test pattern on `9000+N` and metadata
matched to its frames on `9100+N`, until Ctrl-C; options after the channel go to the feed
(`--types`, `--metadata-delay-ms`), and `scripts/test-feed.sh stop [<channel>]` stops it from
another terminal. Keep it off channels a real pipeline feeds.

**End-to-end tests against a deployed build:** `INSIGHT_BASE_URL=https://127.0.0.1:9900 npm run
e2e`. They then record no screenshots, videos or traces. The Viewer's playback tests run only this
way, with the test feed on channel 0; one of them restarts the feed detached, so
`scripts/test-feed.sh stop 0` ends it afterwards. The first run needs Chromium with its system
libraries: `npx playwright install --with-deps chromium`.

## Quality bar

Insight is held to production standards of cleanliness, structure and tests, without
overengineering: no abstraction without a second use or a stated reason, no speculative
configurability. When a quick fix and a clean fix differ, take the clean one or stop and raise it.
