// Fails when the kit's video code is in the initial bundle, or is missing from the build.
//
// The video code (`@sima/neat-ui/video`) is meant to load only with the Viewer route, so the
// other pages and the first paint do not pay for it. The compiler already rejects video symbols
// imported from the kit's primary entry point, but nothing else notices when an import in the
// shared code (a page, the shell, `app.config`) drags the video entry point into the main chunk.
// This script checks the result: `neat-video-tile`, the tile component's selector, is a string
// that survives minification, so it marks where the video code ended up.
//
// Usage: node scripts/check-bundle-split.mjs [dist-dir]   (default: dist, after `npm run build`)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const MARKER = 'neat-video-tile';
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
const holds = (file) => readFileSync(join(dist, file), 'utf8').includes(MARKER);

const leaked = [...initial].filter(holds);
if (leaked.length > 0) {
  console.error(
    `The initial bundle holds the video code (found "${MARKER}" in ${leaked.join(', ')}). ` +
      'Only the Viewer route may import @sima/neat-ui/video.',
  );
  process.exit(1);
}
const carriers = lazy.filter(holds);
if (carriers.length === 0) {
  console.error(
    `No lazy chunk holds "${MARKER}": the video code is missing from the build, or the marker ` +
      'no longer identifies it.',
  );
  process.exit(1);
}
console.log(
  `Video code stays out of ${[...initial].join(', ')} and loads with ${carriers.join(', ')}.`,
);
