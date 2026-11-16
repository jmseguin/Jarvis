import { createMacosUiService } from './service.mjs';

export const MACOS_UI_MCP_CLIENT = {
  id: 'macos-ui',
  name: 'macOS UI Service',
  description: 'Generic macOS Desktop, App, Menu Bar, and Accessibility UI service with Trust Levels.',
  type: 'builtin',
  defaultConfig: {
    maxAxDepth: 4,
    maxAxNodes: 150,
  },
  tools: [
    'ui_trust_status',
    'ui_desktop_info',
    'ui_list_windows',
    'ui_read_app',
    'ui_ax_tree',
    'ui_find',
    'ui_hover',
    'ui_menu_list',
    'ui_menu_click',
    'ui_click',
    'ui_type',
    'ui_hotkey',
    'ui_drag',
    'ui_scroll',
    'ui_bdd_run',
  ],
};

const fmt = (res) => (typeof res === 'string' ? res : JSON.stringify(res, null, 2));

export function createMacosUiTools({
  z,
  hands,
  ask,
  openUrl,
  appControl,
  isEnabled = () => true,
  getConfig = () => ({}),
  getTrustLevel = () => 1,
}) {
  const svc = createMacosUiService({
    hands,
    ask,
    openUrl,
    appControl,
    isEnabled,
    getConfig,
    getTrustLevel,
  });

  const tools = [
    {
      name: 'ui_trust_status',
      description: 'Check the current macOS UI Service trust level, Accessibility permission status, and approved apps.',
      parameters: z.object({}),
      execute: async () => fmt(await svc.trustStatus()),
    },
    {
      name: 'ui_desktop_info',
      description: 'Inspect macOS desktop displays, bounds, and frontmost application metadata.',
      parameters: z.object({}),
      execute: async () => fmt(await svc.runRead('desktop', 'desktop', () => svc.hands('desktop'))),
    },
    {
      name: 'ui_list_windows',
      description: 'List open macOS windows with app name, window title, id, and bounds.',
      parameters: z.object({}),
      execute: async () => fmt(await svc.runRead('windows', 'desktop', () => svc.hands('windows'))),
    },
    {
      name: 'ui_read_app',
      description: 'Read interactive controls (id, role, label, value) and visible text in a macOS app window.',
      parameters: z.object({
        target: z.string().optional().describe("Window target: 'front', an app name like 'Finder' or 'Safari', or 'window:<id>'."),
      }),
      execute: async ({ target = 'front' } = {}) => fmt(await svc.runRead('ui', target, () => svc.hands('ui', target))),
    },
    {
      name: 'ui_ax_tree',
      description: 'Inspect the macOS Accessibility (AXUIElement) tree of a window with roles, titles, identifiers, bounds, and actions.',
      parameters: z.object({
        target: z.string().optional().describe("Target: 'front', app name, or 'window:<id>'."),
        maxDepth: z.number().int().min(1).max(8).optional(),
        maxNodes: z.number().int().min(10).max(400).optional(),
      }),
      execute: async ({ target = 'front', maxDepth, maxNodes } = {}) => {
        const cfg = svc.getConfig() ?? {};
        const d = String(maxDepth ?? cfg.maxAxDepth ?? 4);
        const n = String(maxNodes ?? cfg.maxAxNodes ?? 150);
        return fmt(await svc.runRead('ax-tree', target, () => svc.hands('ax-tree', target, d, n)));
      },
    },
    {
      name: 'ui_menu_list',
      description: 'List the macOS top menu bar items and submenus for an application.',
      parameters: z.object({
        target: z.string().optional().describe("Target app name or 'front'."),
      }),
      execute: async ({ target = 'front' } = {}) => fmt(await svc.runRead('menu-list', target, () => svc.hands('menu-list', target))),
    },
    {
      name: 'ui_menu_click',
      description: 'Click a macOS menu bar item by path (for example ["File", "New Window"]).',
      parameters: z.object({
        target: z.string().optional().describe("Target app name or 'front'."),
        path: z.array(z.string()).min(1).describe('Menu path, e.g. ["File", "Save..."].'),
      }),
      execute: async ({ target = 'front', path }) => fmt(await svc.runMutate(`menu_click ${path.join(' > ')}`, target, false, () => svc.hands('menu-click', target, ...path))),
    },
    {
      name: 'ui_find',
      description: 'BDD-style element locator: find UI elements in any app window by role (e.g. "button", "textbox", "link", "AXWebArea") and/or text substring (matches title, description, value, identifier), returning exact screen coordinates (centerX, centerY, frame).',
      parameters: z.object({
        target: z.string().optional().describe("Target app name (e.g. 'Google Chrome') or 'front'."),
        role: z.string().optional().describe('Optional role substring, e.g. "button", "textbox", "link", "AXWebArea".'),
        text: z.string().optional().describe('Optional case-insensitive substring across title, description, value, or identifier.'),
        maxResults: z.number().int().min(1).max(60).optional(),
        maxDepth: z.number().int().min(1).max(14).optional(),
      }),
      execute: async ({ target = 'front', role, text, maxResults = 20, maxDepth = 10 }) =>
        fmt(await svc.runRead('find', target, () =>
          svc.hands('find', target, JSON.stringify({ role, text, maxResults, maxDepth })),
        )),
    },
    {
      name: 'ui_hover',
      description: 'Activate the target app and move the real mouse cursor to (x, y), a matching element, or the window center to reveal hover controls (e.g. YouTube video play/pause overlay).',
      parameters: z.object({
        target: z.string().optional().describe("Target app name (e.g. 'Google Chrome') or 'front'."),
        role: z.string().optional().describe('Optional element role to hover over.'),
        text: z.string().optional().describe('Optional element text/label to hover over.'),
        x: z.number().optional().describe('Optional screen X coordinate.'),
        y: z.number().optional().describe('Optional screen Y coordinate.'),
      }),
      execute: async ({ target = 'front', role, text, x, y }) =>
        fmt(await svc.runMutate(`hover ${text ?? role ?? (x != null ? `(${x},${y})` : 'window')}`, target, false, async () => {
          let hx = x;
          let hy = y;
          if ((hx == null || hy == null) && (role || text)) {
            const found = await svc.hands('find', target, JSON.stringify({ role, text, maxResults: 3 })).catch(() => null);
            const first = found?.matches?.[0];
            if (first) {
              hx = first.centerX;
              hy = first.centerY;
            }
          }
          return hx != null && hy != null
            ? svc.hands('hover', target, String(hx), String(hy))
            : svc.hands('hover', target);
        })),
    },
    {
      name: 'ui_click',
      description: 'BDD-style click: activates the target app, locates an element by text/role/id (or uses x, y), moves the real mouse cursor there, and performs a real left, right, or double click.',
      parameters: z.object({
        target: z.string().optional().describe("Target app, 'front', or 'desktop'."),
        id: z.string().optional().describe('Control id from ui_read_app.'),
        role: z.string().optional().describe('Optional element role substring (e.g. "button", "AXWebArea").'),
        text: z.string().optional().describe('Element title/description/label substring to locate and click.'),
        x: z.number().optional().describe('Screen X coordinate.'),
        y: z.number().optional().describe('Screen Y coordinate.'),
        button: z.enum(['left', 'right']).optional(),
        clicks: z.number().int().min(1).max(2).optional(),
      }),
      execute: async ({ target = 'front', id, role, text, x, y, button = 'left', clicks = 1 }) => {
        const needsFocus = target && target !== 'front' && target !== 'desktop' && target !== 'screen';
        if (x != null && y != null) {
          const action = button === 'right' ? 'right_click' : clicks === 2 ? 'double_click' : 'click';
          return fmt(await svc.runMutate(`${action} (${x},${y})`, target, false, async () => {
            if (needsFocus) await svc.hands('focus', target);
            return svc.hands('pointer', action, String(x), String(y));
          }));
        }
        if (text || role) {
          const action = button === 'right' ? 'right_click' : clicks === 2 ? 'double_click' : 'click';
          return fmt(await svc.runMutate(`${action} ${text ?? role}`, target, false, async () => {
            const found = await svc.hands('find', target, JSON.stringify({ role, text, maxResults: 5 })).catch(() => null);
            const match = found?.matches?.[0];
            if (match) {
              if (needsFocus) await svc.hands('focus', target);
              return svc.hands('pointer', action, String(match.centerX), String(match.centerY));
            }
            if (id || text) {
              const step = id ? { do: 'click', id } : { do: 'click_text', text };
              const plan = JSON.stringify({ target, allowTerminal: true, steps: [step] });
              if (needsFocus) await svc.hands('focus', target);
              return svc.hands('act', plan);
            }
            return { ok: false, error: `No element matching ${role ? `role="${role}" ` : ''}${text ? `text="${text}" ` : ''}in ${target}` };
          }));
        }
        const plan = JSON.stringify({ target, allowTerminal: true, steps: [{ do: 'click', id }] });
        return fmt(await svc.runMutate(`click ${id}`, target, false, async () => {
          if (needsFocus) await svc.hands('focus', target);
          return svc.hands('act', plan);
        }));
      },
    },
    {
      name: 'ui_type',
      description: 'Activate the target app and type text via real keyboard events (or fill a named field).',
      parameters: z.object({
        target: z.string().optional().describe("Target app or 'front'."),
        field: z.string().optional().describe('Field label/placeholder/id to fill. Omit to type at current focus with real keyboard events.'),
        text: z.string().describe('Text to enter.'),
        pressEnter: z.boolean().optional().describe('Whether to press Return after typing.'),
      }),
      execute: async ({ target = 'front', field, text, pressEnter = false }) => {
        if (!field) {
          return fmt(await svc.runMutate('type_raw', target, pressEnter, async () => {
            const res = await svc.hands('type-raw', text, target);
            if (pressEnter) await svc.hands('hotkey', 'return', target);
            return res;
          }));
        }
        const steps = [{ do: 'fill', field, text }];
        if (pressEnter) steps.push({ do: 'key', key: 'return' });
        const plan = JSON.stringify({ target, allowTerminal: true, steps });
        return fmt(await svc.runMutate(`type into ${field}`, target, pressEnter, () => svc.hands('act', plan)));
      },
    },
    {
      name: 'ui_hotkey',
      description: 'Press ANY single key (e.g. "k", "space", "return", "escape") or keyboard shortcut (e.g. "cmd+c", "cmd+l", "cmd+shift+p") on macOS. Automatically activates the target app first.',
      parameters: z.object({
        target: z.string().optional().describe("Target app (e.g. 'Google Chrome') or 'front'."),
        combo: z.string().describe('Single key or combo, e.g. "k", "space", "cmd+c", "return".'),
      }),
      execute: async ({ target = 'front', combo }) => {
        const hasEnter = /\b(return|enter)\b/i.test(combo);
        const tgt = !target || target === 'desktop' || target === 'screen' ? 'front' : target;
        return fmt(await svc.runMutate(`hotkey ${combo}`, target, hasEnter, () => svc.hands('hotkey', combo, tgt)));
      },
    },
    {
      name: 'ui_drag',
      description: 'Drag the pointer from (x1, y1) to (x2, y2) on the macOS screen.',
      parameters: z.object({
        target: z.string().optional(),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
      }),
      execute: async ({ target = 'desktop', x1, y1, x2, y2 }) => {
        const needsFocus = target && target !== 'front' && target !== 'desktop' && target !== 'screen';
        return fmt(await svc.runMutate(`drag (${x1},${y1})->(${x2},${y2})`, target, false, async () => {
          if (needsFocus) await svc.hands('focus', target);
          return svc.hands('pointer', 'drag', String(x1), String(y1), String(x2), String(y2));
        }));
      },
    },
    {
      name: 'ui_scroll',
      description: 'Scroll inside a macOS app window or list.',
      parameters: z.object({
        target: z.string().optional(),
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(20).optional(),
        text: z.string().optional().describe('Optional anchor text to scroll near.'),
      }),
      execute: async ({ target = 'front', direction, amount = 5, text }) => {
        const plan = JSON.stringify({ target, allowTerminal: true, steps: [{ do: 'scroll', direction, amount, ...(text ? { text } : {}) }] });
        return fmt(await svc.runMutate(`scroll ${direction}`, target, false, () => svc.hands('act', plan)));
      },
    },
    {
      name: 'ui_bdd_run',
      description: 'Execute a BDD-style sequence of UI steps on a target app (focus, hover, find, click, key, type, wait) using real mouse and keyboard events.',
      parameters: z.object({
        target: z.string().describe("Target app name, e.g. 'Google Chrome', or 'front'."),
        steps: z.array(z.object({
          do: z.enum(['focus', 'hover', 'click', 'key', 'type', 'wait']),
          role: z.string().optional(),
          text: z.string().optional(),
          key: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          ms: z.number().int().min(10).max(5000).optional(),
        })).min(1),
      }),
      execute: async ({ target, steps }) => {
        const hasEnter = steps.some((s) => (s.do === 'key' && /\b(return|enter)\b/i.test(s.key ?? '')) || (s.do === 'type' && /\n/.test(s.text ?? '')));
        return fmt(await svc.runMutate(`bdd_run (${steps.length} steps)`, target, hasEnter, async () => {
          const trace = [];
          for (const step of steps) {
            if (step.do === 'focus') {
              trace.push(await svc.hands('focus', target));
            } else if (step.do === 'hover') {
              let hx = step.x;
              let hy = step.y;
              if ((hx == null || hy == null) && (step.role || step.text)) {
                const found = await svc.hands('find', target, JSON.stringify({ role: step.role, text: step.text, maxResults: 3 })).catch(() => null);
                const first = found?.matches?.[0];
                if (first) { hx = first.centerX; hy = first.centerY; }
              }
              trace.push(hx != null && hy != null ? await svc.hands('hover', target, String(hx), String(hy)) : await svc.hands('hover', target));
            } else if (step.do === 'click') {
              let cx = step.x;
              let cy = step.y;
              if ((cx == null || cy == null) && (step.role || step.text)) {
                const found = await svc.hands('find', target, JSON.stringify({ role: step.role, text: step.text, maxResults: 3 })).catch(() => null);
                const first = found?.matches?.[0];
                if (first) { cx = first.centerX; cy = first.centerY; }
              }
              if (cx == null || cy == null) {
                return { ok: false, error: `BDD click could not locate element (${step.role ?? ''} ${step.text ?? ''}) in ${target}`, trace };
              }
              await svc.hands('focus', target);
              trace.push(await svc.hands('pointer', 'click', String(cx), String(cy)));
            } else if (step.do === 'key') {
              trace.push(await svc.hands('hotkey', step.key ?? '', target));
            } else if (step.do === 'type') {
              trace.push(await svc.hands('type-raw', step.text ?? '', target));
            } else if (step.do === 'wait') {
              await new Promise((r) => setTimeout(r, step.ms ?? 250));
              trace.push({ ok: true, waitedMs: step.ms ?? 250 });
            }
          }
          return { ok: true, target, steps: trace.length, trace };
        }));
      },
    },
  ];

  return {
    tools,
    service: svc,
    reset() {},
  };
}
