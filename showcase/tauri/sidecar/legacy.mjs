// Data folders used to carry the upstream name (Roamies). The app is AI Assistant now: move an old folder to its new
// name once, so downloaded voice models and agent work aren't lost or fetched again. Never overwrites anything.
import { existsSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tried = new Set();

/** Renames `oldDir` to `newDir` when only the old one exists. Quiet on any failure: the new location is then used as is. */
export function moveLegacyDir(oldDir, newDir) {
  const key = `${oldDir}\u0000${newDir}`;
  if (tried.has(key)) return false;
  tried.add(key);
  try {
    if (existsSync(oldDir) && !existsSync(newDir)) { renameSync(oldDir, newDir); return true; }
  } catch { /* in use or no permission: leave it */ }
  return false;
}

/** Where the app keeps its downloaded models on Windows (%LOCALAPPDATA%), before and after the rename. */
export const dataRoots = (localAppData = process.env.LOCALAPPDATA) => (localAppData
  ? { now: path.join(localAppData, 'AI Assistant'), before: path.join(localAppData, 'Roamies') }
  : null);

/** The folder the agents work in under `home` (or the test data dir), before and after the rename. */
export const agentRoots = (dataDir = process.env.AI_ASSISTANT_DATA_DIR, home = os.homedir()) => {
  const base = dataDir || home;
  return { now: path.join(base, 'AI Assistant'), before: path.join(base, 'Roamies') };
};
