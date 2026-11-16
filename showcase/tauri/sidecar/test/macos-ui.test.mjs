import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_UI_TRUST_LEVEL,
  UI_TRUST_LEVELS,
  evaluateUiAction,
  normalizeTrustLevel,
} from '../../../../tools/macos-ui/policy.mjs';
import { createMacosUiService } from '../../../../tools/macos-ui/service.mjs';
import { MACOS_UI_MCP_CLIENT, createMacosUiTools } from '../../../../tools/macos-ui/index.mjs';
import { z } from 'zod';

// These drive the macOS helper through the macOS-only service: they only make sense on a Mac.
const MAC_ONLY = { skip: process.platform !== 'darwin' && 'macOS only' };

test('default trust level is 1 (Observe) and normalization clamps invalid values', () => {
  assert.equal(DEFAULT_UI_TRUST_LEVEL, 1);
  assert.equal(UI_TRUST_LEVELS[1].label, 'Observe');
  assert.equal(normalizeTrustLevel(undefined), 1);
  assert.equal(normalizeTrustLevel(null), 1);
  assert.equal(normalizeTrustLevel('invalid'), 1);
  assert.equal(normalizeTrustLevel(-1), 1);
  assert.equal(normalizeTrustLevel(99), 1);
  assert.equal(normalizeTrustLevel(3), 3);
});

test('Level 0 (Off) blocks reads and mutations', () => {
  const r = evaluateUiAction({ action: 'desktop', kind: 'read' }, { trustLevel: 0 });
  assert.equal(r.decision, 'block');
  const m = evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Notes' }, { trustLevel: 0 });
  assert.equal(m.decision, 'block');
});

test('Level 1 (Observe) allows reads and blocks mutations', () => {
  const r = evaluateUiAction({ action: 'ax-tree', kind: 'read' }, { trustLevel: 1 });
  assert.equal(r.decision, 'allow');
  const m = evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Notes' }, { trustLevel: 1 });
  assert.equal(m.decision, 'block');
  assert.match(m.reason, /Observe Only/);
});

test('Level 2 (Assisted) allows reads and asks on every mutation', () => {
  const r = evaluateUiAction({ action: 'windows', kind: 'read' }, { trustLevel: 2 });
  assert.equal(r.decision, 'allow');
  const m = evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Notes' }, {
    trustLevel: 2,
    approvedApps: { notes: { name: 'Notes', key: 'notes' } },
  });
  assert.equal(m.decision, 'ask');
});

test('Level 3 (App-Scoped) allows approved apps, asks unapproved, and enforces confirmBeforeEnter', () => {
  const ctx = {
    trustLevel: 3,
    approvedApps: { notes: { name: 'Notes', key: 'notes' } },
    sessionApps: {},
    confirmBeforeEnter: true,
  };
  assert.equal(evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Notes' }, ctx).decision, 'allow');
  assert.equal(evaluateUiAction({ action: 'type', kind: 'mutate', targetApp: 'Notes', hasEnter: true }, ctx).decision, 'ask');
  assert.equal(evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Safari' }, ctx).decision, 'ask');
});

test('Level 4 (Full Desktop) allows unapproved non-blocked apps but still enforces HANDS_OFF and Enter confirm', () => {
  const ctx = { trustLevel: 4, approvedApps: {}, sessionApps: {}, confirmBeforeEnter: true };
  assert.equal(evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'Safari' }, ctx).decision, 'allow');
  assert.equal(evaluateUiAction({ action: 'hotkey', kind: 'mutate', targetApp: 'Safari', hasEnter: true }, ctx).decision, 'ask');
  assert.equal(
    evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: '1Password', bundleId: 'com.1password.1password' }, ctx).decision,
    'block',
  );
  assert.equal(
    evaluateUiAction({ action: 'click', kind: 'mutate', targetApp: 'System Settings', bundleId: 'com.apple.systempreferences' }, ctx).decision,
    'block',
  );
});

test('createMacosUiService gates calls, prompts on ask, and approves app when chosen', MAC_ONLY, async () => {
  let level = 1;
  const approved = {};
  const prompts = [];
  let askReply = 'Allow once';

  const svc = createMacosUiService({
    hands: async (cmd) => {
      if (cmd === 'trusted') return { trusted: true };
      if (cmd === 'front') return { app: 'Notes', bundle: 'com.apple.Notes' };
      if (cmd === 'locate') return { window: { app: 'Notes', bundle: 'com.apple.Notes' } };
      return { ok: true, cmd };
    },
    ask: async (payload) => {
      prompts.push(payload);
      return askReply;
    },
    appControl: {
      snapshot: () => ({ approvedApps: approved, sessionApps: {}, confirmBeforeEnter: true }),
      approve: (name, meta) => { approved[name.toLowerCase()] = { name, ...meta }; },
    },
    getTrustLevel: () => level,
  });

  // Level 1: read succeeds, mutate returns blocked
  assert.equal(svc.levels.length, 5);
  assert.equal(svc.getTrustLevelInfo().level, 1);
  assert.equal(svc.getTrustLevelInfo().label, 'Observe');
  const res1 = await svc.runRead('desktop', 'desktop', async () => ({ ok: true }));
  assert.equal(res1.ok, true);
  const blocked = await svc.runMutate('click btn', 'Notes', false, async () => ({ ok: true }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);

  // Level 2: mutate triggers confirmation
  level = 2;
  askReply = 'Cancel';
  const denied = await svc.runMutate('click btn', 'Notes', false, async () => ({ ok: true }));
  assert.equal(denied.ok, false);
  assert.equal(denied.cancelled, true);
  assert.equal(prompts.length, 1);

  askReply = 'Approve Notes';
  const res2 = await svc.runMutate('click btn', 'Notes', false, async () => ({ ok: true, clicked: true }));
  assert.equal(res2.clicked, true);
  assert.ok(approved.notes);

  const logFile = path.join(os.homedir(), '.gg', 'sidekick', 'logs', 'ui-actions.jsonl');
  assert.equal(fs.existsSync(logFile), true);
});

test('BDD tools (ui_find, ui_hover, ui_bdd_run) are registered and execute multi-step traces', MAC_ONLY, async () => {
  assert.ok(MACOS_UI_MCP_CLIENT.tools.includes('ui_find'));
  assert.ok(MACOS_UI_MCP_CLIENT.tools.includes('ui_hover'));
  assert.ok(MACOS_UI_MCP_CLIENT.tools.includes('ui_bdd_run'));

  const calls = [];
  const { tools } = createMacosUiTools({
    z,
    hands: async (...args) => {
      calls.push(args);
      const [cmd] = args;
      if (cmd === 'trusted') return { trusted: true };
      if (cmd === 'front') return { app: 'Google Chrome', bundle: 'com.google.Chrome' };
      if (cmd === 'locate') return { window: { app: 'Google Chrome', bundle: 'com.google.Chrome' } };
      if (cmd === 'find') {
        return {
          ok: true,
          count: 1,
          matches: [{ role: 'AXButton', title: 'Pause', centerX: 400, centerY: 300 }],
        };
      }
      return { ok: true, cmd, args: args.slice(1) };
    },
    ask: async () => 'Allow once',
    appControl: {
      snapshot: () => ({ approvedApps: { 'google chrome': { name: 'Google Chrome' } }, sessionApps: {}, confirmBeforeEnter: true }),
      approve: () => {},
    },
    getTrustLevel: () => 3,
  });

  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const findRes = JSON.parse(await byName.ui_find.execute({ target: 'Google Chrome', role: 'button', text: 'Pause' }));
  assert.equal(findRes.ok, true);
  assert.equal(findRes.count, 1);

  const hoverRes = JSON.parse(await byName.ui_hover.execute({ target: 'Google Chrome', x: 400, y: 300 }));
  assert.equal(hoverRes.ok, true);

  const bddRes = JSON.parse(
    await byName.ui_bdd_run.execute({
      target: 'Google Chrome',
      steps: [
        { do: 'focus' },
        { do: 'hover', x: 400, y: 300 },
        { do: 'click', role: 'button', text: 'Pause' },
        { do: 'key', key: 'k' },
        { do: 'type', text: 'hello' },
        { do: 'wait', ms: 1 },
      ],
    }),
  );

  assert.equal(bddRes.ok, true);
  assert.equal(bddRes.steps, 6);
  assert.equal(bddRes.trace.length, 6);
  assert.ok(calls.some((a) => a[0] === 'focus'));
  assert.ok(calls.some((a) => a[0] === 'hover'));
  assert.ok(calls.some((a) => a[0] === 'pointer' && a[1] === 'click'));
  assert.ok(calls.some((a) => a[0] === 'hotkey' && a[1] === 'k'));
  assert.ok(calls.some((a) => a[0] === 'type-raw' && a[1] === 'hello'));
});
