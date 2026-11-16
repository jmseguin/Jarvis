import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateUiAction, normalizeTrustLevel, trustLevelInfo, UI_TRUST_LEVELS } from './policy.mjs';

const AUDIT_LOG = path.join(os.homedir(), '.gg', 'sidekick', 'logs', 'ui-actions.jsonl');

async function appendAudit(entry) {
  try {
    await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true, mode: 0o700 });
    await fs.appendFile(AUDIT_LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch { /* audit failure never breaks the tool */ }
}

/**
 * The trust-level gate every desktop-control tool runs through. Built for macOS (the `ui_*` tools, which stay
 * macOS-only); `platforms` and `label` let the Windows-MCP client reuse it on Windows with the hands-win helper,
 * which answers the same `front` / `locate` commands.
 */
export function createMacosUiService({
  hands,
  ask,
  openUrl,
  appControl,
  isEnabled = () => true,
  getConfig = () => ({}),
  getTrustLevel = () => 1,
  platforms = ['darwin'],
  label = 'macOS UI Service',
}) {
  const platformName = platforms.includes('darwin') ? 'macOS' : platforms.includes('win32') ? 'Windows' : platforms.join('/');
  const requirePlatform = () => {
    if (!platforms.includes(process.platform)) {
      throw new Error(`${label} is only supported on ${platformName}.`);
    }
  };
  const requireHands = () => {
    requirePlatform();
    if (!hands) {
      throw new Error(`${platformName} UI helper (roamies-hands) is not available in this environment.`);
    }
  };

  // The macOS helper names an app by bundle id; the Windows one by program name ("exe", no extension).
  const idOf = (r) => r?.bundle ?? r?.exe ?? '';

  async function resolveTargetMeta(target) {
    if (!target || target === 'desktop' || target === 'screen') return { app: '', bundleId: '' };
    if (target === 'front') {
      const f = await hands('front').catch(() => null);
      return { app: f?.app ?? '', bundleId: idOf(f) };
    }
    const loc = await hands('locate', target).catch(() => null);
    return { app: loc?.window?.app ?? target, bundleId: idOf(loc?.window) };
  }

  /** `kind: 'system'` is for tools that reach past the screen (PowerShell, files, registry, processes): `safety` is the
   *  safety.mjs verdict for this exact call, and the trust level must be Full Desktop before it even applies. */
  async function guardAndRun({ action, kind, target = 'front', hasEnter = false, safety = null }, fn) {
    // Only a mutation needs the helper (to find out which app it lands in); reads and system calls need the right OS.
    if (kind === 'mutate') requireHands(); else requirePlatform();
    const trustLevel = normalizeTrustLevel(getTrustLevel());
    const enabled = isEnabled();
    const meta = kind === 'mutate' ? await resolveTargetMeta(target) : { app: '', bundleId: '' };
    const snap = appControl?.snapshot?.() ?? {};
    const evalResult = evaluateUiAction(
      { action, kind, targetApp: meta.app, bundleId: meta.bundleId, hasEnter, safety },
      {
        trustLevel,
        enabled,
        label,
        approvedApps: snap.approvedApps ?? {},
        sessionApps: snap.sessionApps ?? {},
        confirmBeforeEnter: snap.confirmBeforeEnter !== false,
      }
    );

    if (evalResult.decision === 'block') {
      await appendAudit({ level: trustLevel, action, target: meta.app || target, decision: 'block', reason: evalResult.reason });
      return { ok: false, blocked: true, trustLevel: trustLevelInfo(trustLevel).label, error: evalResult.reason };
    }

    if (evalResult.decision === 'ask') {
      if (!ask) {
        await appendAudit({ level: trustLevel, action, target: meta.app || target, decision: 'block_no_ask', reason: evalResult.reason });
        return { ok: false, blocked: true, error: evalResult.reason };
      }
      // A system call (PowerShell, files, ...) is never approved "for good": it asks every time.
      const choices = meta.app && kind !== 'system' ? ['Allow once', `Approve ${meta.app}`, 'Cancel'] : ['Allow once', 'Cancel'];
      const reply = await ask({
        prompt: `UI Action (${trustLevelInfo(trustLevel).label}): ${action}${meta.app ? ` in ${meta.app}` : ''}. ${evalResult.reason}`,
        choices,
      });
      if (!reply || reply === 'Cancel') {
        await appendAudit({ level: trustLevel, action, target: meta.app || target, decision: 'denied' });
        return { ok: false, cancelled: true, error: 'User cancelled the UI action.' };
      }
      if (meta.app && reply === `Approve ${meta.app}`) {
        appControl?.approve?.(meta.app, { mode: 'always', bundleId: meta.bundleId });
      }
    }

    try {
      const result = await fn();
      if (kind !== 'read') {
        await appendAudit({ level: trustLevel, action, target: meta.app || target, decision: evalResult.decision, ok: result?.ok !== false });
      }
      return result;
    } catch (error) {
      if (kind !== 'read') {
        await appendAudit({ level: trustLevel, action, target: meta.app || target, decision: evalResult.decision, ok: false, error: error.message });
      }
      throw error;
    }
  }

  return {
    levels: UI_TRUST_LEVELS,
    getTrustLevelInfo: () => trustLevelInfo(getTrustLevel()),
    trustStatus: async () => {
      const level = normalizeTrustLevel(getTrustLevel());
      const info = trustLevelInfo(level);
      let axTrusted = null;
      if (process.platform === 'darwin' && hands) {
        const t = await hands('trusted').catch(() => null);
        axTrusted = t ? !!t.trusted : null;
      }
      const snap = appControl?.snapshot?.() ?? {};
      return {
        ok: true,
        enabled: isEnabled(),
        trustLevel: level,
        trustKey: info.key,
        trustLabel: info.label,
        description: info.desc,
        accessibilityTrusted: axTrusted,
        confirmBeforeEnter: snap.confirmBeforeEnter !== false,
        approvedApps: Object.values(snap.approvedApps ?? {}).map((a) => a.name),
        config: getConfig(),
      };
    },
    openAccessibilitySettings: () => {
      if (process.platform === 'darwin' && openUrl) {
        openUrl('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
    },
    runRead: (action, target, fn) => guardAndRun({ action, kind: 'read', target }, fn),
    runMutate: (action, target, hasEnter, fn) => guardAndRun({ action, kind: 'mutate', target, hasEnter }, fn),
    runSystem: (action, safety, fn) => guardAndRun({ action, kind: 'system', safety }, fn),
    hands: (...args) => {
      requireHands();
      return hands(...args);
    },
    getConfig,
  };
}
