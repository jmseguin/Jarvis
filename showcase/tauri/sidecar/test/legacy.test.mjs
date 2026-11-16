// The one-time move of data folders from the old Roamies names to AI Assistant. Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentRoots, dataRoots, moveLegacyDir } from '../legacy.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-assistant-legacy-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ } });
const mk = (...p) => { const d = path.join(TMP, ...p); fs.mkdirSync(d, { recursive: true }); return d; };

// Only the old folder exists: it moves, with its contents.
{
  const before = mk('a', 'Roamies', 'models'); fs.writeFileSync(path.join(before, 'x.bin'), 'model');
  const now = path.join(TMP, 'a', 'AI Assistant');
  assert.equal(moveLegacyDir(path.join(TMP, 'a', 'Roamies'), now), true);
  assert.equal(fs.readFileSync(path.join(now, 'models', 'x.bin'), 'utf8'), 'model');
  assert.equal(fs.existsSync(path.join(TMP, 'a', 'Roamies')), false);
}
// Both exist: nothing is touched, nothing overwritten.
{
  const before = mk('b', 'Roamies'); fs.writeFileSync(path.join(before, 'old.txt'), 'old');
  const now = mk('b', 'AI Assistant'); fs.writeFileSync(path.join(now, 'new.txt'), 'new');
  assert.equal(moveLegacyDir(before, now), false);
  assert.ok(fs.existsSync(path.join(before, 'old.txt')) && fs.existsSync(path.join(now, 'new.txt')));
  assert.equal(fs.existsSync(path.join(now, 'old.txt')), false);
}
// Neither exists, or asked again: quiet no-ops.
assert.equal(moveLegacyDir(path.join(TMP, 'c', 'Roamies'), path.join(TMP, 'c', 'AI Assistant')), false);
{
  const before = mk('d', 'Roamies'); const now = path.join(TMP, 'd', 'AI Assistant');
  assert.equal(moveLegacyDir(before, now), true);
  assert.equal(moveLegacyDir(before, now), false, 'a second call does nothing');
}
// Where the folders are.
assert.deepEqual(dataRoots('C:\\L'), { now: path.join('C:\\L', 'AI Assistant'), before: path.join('C:\\L', 'Roamies') });
assert.equal(dataRoots(''), null);
assert.deepEqual(agentRoots(undefined, '/h'), { now: path.join('/h', 'AI Assistant'), before: path.join('/h', 'Roamies') });
assert.deepEqual(agentRoots('/data', '/h'), { now: path.join('/data', 'AI Assistant'), before: path.join('/data', 'Roamies') });

console.log('legacy tests: ok');
