// Fails when code that belongs to a lazy route is in the initial bundle, or is missing from the
// build.
//
// The Viewer's video code (`@sima/neat-ui/video`) and the Streaming and Media pages, with the kit
// entries only they use, are meant to load with their routes, and the top bar's board dialog on
// its first open, so the first paint does not pay for them. The compiler already rejects video
// symbols imported from the kit's primary entry point, but nothing else notices when an import in
// the shared code (a page, the shell, `app.config`) drags one of these into the main chunk. This script checks the result: each marker below is a
// component selector, a string that survives minification, so it shows where the code ended up.
//
// `neat-toast-host` and `neat-status-chip` are not markers on purpose: the app root renders the
// toast host and the top bar's board pill shows its state in a status chip, so those two kit
// entries are in the initial bundle by design.
//
// Usage: node scripts/check-bundle-split.mjs [dist-dir]   (default: dist, after `npm run build`)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** What stays out of the initial bundle, as a selector in the code that carries it. */
const LAZY_CODE = [
  { marker: 'neat-video-tile', what: 'the video code', route: 'the Viewer route' },
  { marker: 'app-streaming-page', what: 'the Streaming page', route: 'the Streaming route' },
  { marker: 'app-media-page', what: 'the Media page', route: 'the Media route' },
  // The kit entries the two pages use (the file browser, the checked and selection lists, dialogs).
  { marker: 'neat-file-browser', what: 'the kit’s file browser', route: 'Streaming and Media' },
  { marker: 'neat-select-list', what: 'the kit’s select list', route: 'Streaming and Media' },
  {
    marker: 'neat-dialog',
    what: 'the kit’s dialog',
    route: 'Streaming, Media and the board dialog',
  },
  // The board dialog is imported when the pill first opens it (`TopBarDialogs`), with the kit
  // entries it brings beside the dialog.
  { marker: 'app-board-dialog', what: 'the board dialog', route: 'the board dialog’s first open' },
  { marker: 'neat-collapsible', what: 'the kit’s collapsible', route: 'the board dialog' },
  { marker: 'neat-callout', what: 'the kit’s callout', route: 'the board dialog and the Viewer' },
];
const dist = process.argv[2] ?? 'dist';

// The initial chunks are what index.html loads on its own: the entry script and the chunks it
// preloads. Tags are read attribute by attribute, so neither the attribute order nor the quote
// style of the build output matters.
function attributes(tag) {
  const found = {};
  for (const [, name, doubleQuoted, singleQuoted, bare] of tag.matchAll(
    /\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
  )) {
    found[name.toLowerCase()] = doubleQuoted ?? singleQuoted ?? bare ?? '';
  }
  return found;
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = new Set();
for (const [tag] of html.matchAll(/<(?:script|link)\s[^>]*>/gi)) {
  const { src, href, rel } = attributes(tag);
  const file = tag.toLowerCase().startsWith('<script')
    ? src
    : rel === 'modulepreload'
      ? href
      : null;
  if (file?.endsWith('.js')) {
    initial.add(file);
  }
}
if (initial.size === 0) {
  console.error(`No initial scripts found in ${join(dist, 'index.html')}.`);
  process.exit(1);
}

const lazy = readdirSync(dist).filter((file) => file.endsWith('.js') && !initial.has(file));
const read = (file) => readFileSync(join(dist, file), 'utf8');
const initialCode = [...initial].map((file) => [file, read(file)]);
const lazyCode = lazy.map((file) => [file, read(file)]);

const problems = [];
const loads = [];
for (const { marker, what, route } of LAZY_CODE) {
  const leaked = initialCode.filter(([, code]) => code.includes(marker)).map(([file]) => file);
  if (leaked.length > 0) {
    problems.push(
      `The initial bundle holds ${what} (found "${marker}" in ${leaked.join(', ')}). ` +
        `Only ${route} may import it.`,
    );
    continue;
  }
  const carriers = lazyCode.filter(([, code]) => code.includes(marker)).map(([file]) => file);
  if (carriers.length === 0) {
    problems.push(
      `No lazy chunk holds "${marker}": ${what} is missing from the build, or the marker no ` +
        'longer identifies it.',
    );
    continue;
  }
  loads.push(`${what[0].toUpperCase()}${what.slice(1)} loads with ${carriers.join(', ')}.`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(loads.join('\n'));
console.log(`None of it is in ${[...initial].join(', ')}.`);
