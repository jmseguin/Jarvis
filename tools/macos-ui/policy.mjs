import { isAppApproved, isHardBlockedApp, isTerminalApp } from '../../showcase/tauri/sidecar/safety.mjs';

export const UI_TRUST_LEVELS = [
  { level: 0, key: 'off', label: 'Off', desc: 'macOS UI Service is disabled.' },
  { level: 1, key: 'observe', label: 'Observe', desc: 'Read-only: inspect desktop, windows, menus, and AX elements.' },
  { level: 2, key: 'assisted', label: 'Assisted', desc: 'Ask confirmation before every click, keystroke, menu, or drag.' },
  { level: 3, key: 'app_scoped', label: 'App-Scoped', desc: 'Act autonomously in Approved Apps; ask elsewhere.' },
  { level: 4, key: 'full', label: 'Full Desktop', desc: 'Act autonomously across desktop, Finder, menus, and apps.' },
];

export const DEFAULT_UI_TRUST_LEVEL = 1; // Observe Only

export function normalizeTrustLevel(v) {
  if (v == null || v === '') return DEFAULT_UI_TRUST_LEVEL;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 0 && n <= 4) return n;
  return DEFAULT_UI_TRUST_LEVEL;
}

export function trustLevelInfo(v) {
  const lvl = normalizeTrustLevel(v);
  return UI_TRUST_LEVELS[lvl] ?? UI_TRUST_LEVELS[DEFAULT_UI_TRUST_LEVEL];
}

/**
 * Evaluates whether a macOS UI action is allowed, needs confirmation, or is blocked.
 * @param {{ action: string, kind: 'read'|'mutate', targetApp?: string, bundleId?: string, hasEnter?: boolean }} req
 * @param {{ trustLevel?: number, enabled?: boolean, approvedApps?: object, sessionApps?: object, confirmBeforeEnter?: boolean }} ctx
 * @returns {{ decision: 'allow'|'ask'|'block', reason: string }}
 */
export function evaluateUiAction(req, ctx = {}) {
  const enabled = ctx.enabled !== false;
  const level = normalizeTrustLevel(ctx.trustLevel);
  if (!enabled || level === 0) {
    return { decision: 'block', reason: 'macOS UI Service is disabled (Trust Level: Off).' };
  }

  const app = String(req?.targetApp ?? '').trim();
  const bundleId = String(req?.bundleId ?? '').trim();

  if (req?.kind === 'read') {
    return { decision: 'allow', reason: 'Read-only UI observation is allowed.' };
  }

  if (app && isHardBlockedApp(app, bundleId)) {
    return { decision: 'block', reason: `${app} is hard-blocked for UI automation safety.` };
  }

  if (level === 1) {
    return { decision: 'block', reason: 'Trust Level is Observe Only; UI mutations are blocked.' };
  }

  if (level === 2) {
    return { decision: 'ask', reason: `Assisted mode requires confirmation for ${req.action}${app ? ` in ${app}` : ''}.` };
  }

  if (req?.hasEnter && ctx.confirmBeforeEnter !== false) {
    return { decision: 'ask', reason: `Confirm before pressing Enter${app ? ` in ${app}` : ''}.` };
  }

  if (level === 3) {
    const approved = app && isAppApproved(app, bundleId, { approvedApps: ctx.approvedApps ?? {}, sessionApps: ctx.sessionApps ?? {} });
    if (approved) {
      return { decision: 'allow', reason: `${app} is in Approved Apps.` };
    }
    if (app && isTerminalApp(app, bundleId)) {
      return { decision: 'ask', reason: `${app} is a terminal app and not yet approved.` };
    }
    return { decision: 'ask', reason: `${app || 'This target'} is not in Approved Apps (App-Scoped trust).` };
  }

  // Level 4: Full Desktop (still asks for unapproved terminal apps unless approved)
  if (app && isTerminalApp(app, bundleId) && !isAppApproved(app, bundleId, { approvedApps: ctx.approvedApps ?? {}, sessionApps: ctx.sessionApps ?? {} })) {
    return { decision: 'ask', reason: `${app} is a terminal app and needs approval.` };
  }

  return { decision: 'allow', reason: 'Allowed under Full Desktop trust.' };
}
