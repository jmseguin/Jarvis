// The product is AI Assistant. "Roamies" (the upstream app this was forked from) may only stay where it is the name of the
// avatar you can pick beside Jarvis (its wake word and names), a credit to the people who made the original, or the
// one-time move of old data folders. Anything else is the old name leaking back in. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', '.ua', 'icons', 'fonts', 'binaries', 'gen']);
const SKIP_EXT = /\.(png|jpe?g|gif|ico|icns|tiff?|ttf|otf|woff2?|pcm|wav|mp3|zip|gz|exe|dll|onnx|lock|pma|bin)$/i;

// Whole files where the old name is the point.
const FILES = [
  'showcase/tauri/sidecar/wakename.mjs', // the avatar's default wake name
  'showcase/tauri/sidecar/test/wakename.test.mjs',
  'showcase/tauri/sidecar/legacy.mjs', // moves the old Roamies data folders
  'showcase/tauri/sidecar/test/legacy.test.mjs',
  'showcase/tauri/sidecar/test/branding.test.mjs', // this file
];
// Single lines: the avatar (wake word, names, behaviour) and credits.
const LINES = [
  /hey roamies/i,           // "Hey Roamies": the avatar's wake word
  /wake ?name/i,            // the wake name setting and its default
  /defaultNames/,           // the voice helper's wake names for the avatar
  /Roamie's/,               // how the voice helper hears the avatar's name
  /Anchored roamies/,       // the avatar's behaviour (a comment in the overlay)
  /made Roamies/,           // credit: Ken Kai made the original Roamies
  /Ken Kai/,                // credit line in the README
];

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); } else if (!SKIP_EXT.test(e.name)) yield path.join(dir, e.name);
  }
}

const found = [];
let scanned = 0;
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (FILES.includes(rel)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  scanned++;
  text.split('\n').forEach((line, i) => {
    if (/roamies(?![a-z])/i.test(line) && !LINES.some((re) => re.test(line))) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
}
assert.ok(scanned > 100, `scanned only ${scanned} files: the walk is broken`);
assert.deepEqual(found, [], `the old name "Roamies" is back:\n${found.join('\n')}`);

// The file names too: no tracked file or folder is named after the old app.
const named = [];
for (const file of walk(ROOT)) { if (/roamies(?![a-z])/i.test(path.basename(file))) named.push(path.relative(ROOT, file)); }
for (const dir of ['showcase', 'showcase/overlay', 'showcase/tauri/src-tauri']) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { if (/roamies(?![a-z])/i.test(e.name)) named.push(`${dir}/${e.name}`); }
}
assert.deepEqual(named, [], `files named after the old app: ${named.join(', ')}`);

console.log(`branding tests: ok (${scanned} files)`);
