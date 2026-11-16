// CursorTouch/Windows-MCP (MIT, https://github.com/CursorTouch/Windows-MCP): a stdio MCP server that drives the Windows
// desktop. The Windows twin of macos-mcp.mjs. Not bundled: the user installs uv and `uvx` fetches the pinned
// release on first use (it needs Python 3.14, which uv downloads itself, so the first call is slow).
//
// Every call goes through the same trust-level gate as the macOS tools (macos-ui/service.mjs). The tools that reach
// past the screen (PowerShell, FileSystem, Registry, Process) need Full Desktop trust and are also checked by
// safety.mjs (checkWindowsSystemAction), which refuses the dangerous ones at every level.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { createInterface } from 'node:readline';
import { checkWindowsSystemAction } from '../showcase/tauri/sidecar/safety.mjs';

const winPath = nodePath.win32;

/** The Windows-MCP release `uvx` runs. Pinned, so a new upstream release never changes what the app runs unnoticed. */
export const WINDOWS_MCP_VERSION = '0.8.8';

const bool = (z, d) => z.boolean().optional().describe(d);
const xy = (z) => z.array(z.number().int()).length(2);
const LOC = (z) => ({
  loc: xy(z).optional().describe('Screen [x, y] coordinates. Give this or label.'),
  label: z.number().int().optional().describe('Element label id from a Snapshot. Give this or loc.'),
});

// kind: 'read' looks, 'mutate' clicks/types (gated per app), 'system' reaches past the screen (Full Desktop only,
// plus safety.mjs). `kind` may be a function of the arguments when one tool does both (Clipboard).
const TOOL_SPECS = [
  {
    name: 'windows_mcp_snapshot', remote: 'Snapshot', kind: 'read',
    description: 'Capture the Windows desktop state: windows, interactive elements with label ids and coordinates (set use_vision=true to include a screenshot).',
    buildParams: (z) => z.object({
      use_vision: bool(z, 'Include a screenshot.'),
      use_dom: bool(z, 'For a browser, list the web page elements instead of the browser UI.'),
      use_annotation: bool(z, 'Draw boxes around the elements on the screenshot (default true).'),
      use_ui_tree: bool(z, 'Set false to skip the element list (default true).'),
      display: z.array(z.number().int().min(0)).optional().describe('Zero-based display numbers, e.g. [0].'),
      region: z.array(z.number().int()).length(4).optional().describe('[left, top, right, bottom] in virtual-desktop pixels. Wins over display.'),
    }),
  },
  {
    name: 'windows_mcp_screenshot', remote: 'Screenshot', kind: 'read',
    description: 'Fast screenshot of the desktop with cursor position and a window summary (no element list).',
    buildParams: (z) => z.object({
      use_annotation: bool(z, 'Draw boxes around detected elements.'),
      display: z.array(z.number().int().min(0)).optional(),
      region: z.array(z.number().int()).length(4).optional().describe('[left, top, right, bottom] in virtual-desktop pixels.'),
    }),
  },
  {
    name: 'windows_mcp_displays', remote: 'DisplayInventory', kind: 'read',
    description: 'List the displays with their layout and DPI.',
    buildParams: (z) => z.object({}),
  },
  {
    name: 'windows_mcp_control_status', remote: 'ControlStatus', kind: 'read',
    description: 'Who is in control of the desktop right now, and how long until the user has been idle long enough.',
    buildParams: (z) => z.object({}),
  },
  {
    name: 'windows_mcp_wait', remote: 'Wait', kind: 'read',
    description: 'Wait a number of seconds.',
    buildParams: (z) => z.object({ duration: z.number().int().min(1).max(30).describe('Seconds to wait.') }),
  },
  {
    name: 'windows_mcp_wait_for', remote: 'WaitFor', kind: 'read',
    description: 'Wait until something shows on screen: text, a window, or an element that exists, is enabled or has focus.',
    buildParams: (z) => z.object({
      condition: z.enum(['text_exists', 'active_window', 'element_exists', 'element_enabled', 'focused_element']),
      text: z.string().optional().describe('The text or element name to wait for.'),
      window_name: z.string().optional().describe('For active_window: part of the window title.'),
      timeout: z.number().min(1).max(60).optional().describe('Seconds to wait at most (default 10).'),
      interval: z.number().min(0.1).max(5).optional(),
      use_dom: bool(z, 'Look at the web page elements for a browser.'),
    }),
  },
  {
    name: 'windows_mcp_scrape', remote: 'Scrape', kind: 'read',
    description: 'Fetch a public web page and return its content as text.',
    buildParams: (z) => z.object({
      url: z.string().describe('The http(s) address.'),
      query: z.string().optional().describe('What to look for, to focus the result.'),
      use_dom: bool(z, 'Read the page open in the browser instead of fetching it.'),
    }),
  },
  {
    name: 'windows_mcp_clipboard', remote: 'Clipboard',
    kind: (a) => (String(a?.mode ?? '').toLowerCase() === 'get' ? 'read' : 'mutate'),
    description: 'Read the clipboard text (mode "get") or set it (mode "set").',
    buildParams: (z) => z.object({
      mode: z.enum(['get', 'set']),
      text: z.string().optional().describe('For set: the text to put on the clipboard.'),
    }),
  },
  {
    name: 'windows_mcp_click', remote: 'Click', kind: 'mutate',
    description: 'Click at screen coordinates [x, y] or on an element label from a Snapshot.',
    buildParams: (z) => z.object({
      ...LOC(z),
      button: z.enum(['left', 'right', 'middle']).optional(),
      clicks: z.number().int().min(1).max(3).optional().describe('1 click, 2 double-click, 3 triple-click.'),
    }),
  },
  {
    name: 'windows_mcp_type', remote: 'Type', kind: 'mutate',
    description: 'Click a field (coordinates or element label) and type text into it.',
    buildParams: (z) => z.object({
      text: z.string().describe('Text to type.'),
      ...LOC(z),
      clear: bool(z, 'Clear the field first.'),
      caret_position: z.enum(['start', 'idle', 'end']).optional(),
      press_enter: bool(z, 'Press Enter afterwards.'),
    }),
  },
  {
    name: 'windows_mcp_scroll', remote: 'Scroll', kind: 'mutate',
    description: 'Scroll at coordinates, on an element, or at the mouse pointer.',
    buildParams: (z) => z.object({
      ...LOC(z),
      type: z.enum(['horizontal', 'vertical']).optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      wheel_times: z.number().int().min(1).max(50).optional(),
    }),
  },
  {
    name: 'windows_mcp_move', remote: 'Move', kind: 'mutate',
    description: 'Move the mouse pointer to coordinates or an element, or drag (from from_loc, or from where it is).',
    buildParams: (z) => z.object({
      ...LOC(z),
      drag: bool(z, 'Hold the button down while moving.'),
      from_loc: xy(z).optional().describe('Where a drag starts.'),
      duration: z.number().min(0).max(10).optional().describe('Seconds the move takes.'),
    }),
  },
  {
    name: 'windows_mcp_shortcut', remote: 'Shortcut', kind: 'mutate',
    description: 'Press a key or shortcut, with + between keys (for example "ctrl+c", "alt+tab", "win+d", "enter").',
    buildParams: (z) => z.object({ shortcut: z.string() }),
  },
  {
    name: 'windows_mcp_multi_select', remote: 'MultiSelect', kind: 'mutate',
    description: 'Select several items (files, rows, checkboxes) by coordinates or element labels; with press_ctrl they stay selected together.',
    buildParams: (z) => z.object({
      locs: z.array(xy(z)).optional().describe('[[x, y], ...]'),
      labels: z.array(z.number().int()).optional(),
      press_ctrl: bool(z, 'Hold Ctrl while clicking (default true).'),
    }),
  },
  {
    name: 'windows_mcp_multi_edit', remote: 'MultiEdit', kind: 'mutate',
    description: 'Type into several fields in one go: locs is [[x, y, text], ...] and labels is [[label, text], ...].',
    buildParams: (z) => z.object({
      locs: z.array(z.tuple([z.number().int(), z.number().int(), z.string()])).optional(),
      labels: z.array(z.tuple([z.number().int(), z.string()])).optional(),
    }),
  },
  {
    name: 'windows_mcp_app', remote: 'App', kind: 'mutate',
    description: 'Launch an app by name, switch to it, or move or resize its window. Programs are never launched by file path.',
    buildParams: (z) => z.object({
      mode: z.enum(['launch', 'launch_executable', 'resize', 'switch']).optional().describe('Default: launch.'),
      name: z.string().nullable().optional().describe('App name, e.g. "Notepad".'),
      window_loc: z.array(z.number().int()).length(2).optional().describe('[x, y] for move.'),
      window_size: z.array(z.number().int()).length(2).optional().describe('[width, height] for resize.'),
      executable: z.string().optional().describe('Only for launch_executable, which is not allowed.'),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
    }),
  },
  {
    name: 'windows_mcp_notification', remote: 'Notification', kind: 'mutate',
    description: 'Show a Windows toast notification.',
    buildParams: (z) => z.object({
      title: z.string(),
      message: z.string(),
      app_id: z.string().describe('A valid Application User Model ID, so Windows shows the toast.'),
    }),
  },
  {
    name: 'windows_mcp_powershell', remote: 'PowerShell', kind: 'system',
    description: 'Run a PowerShell command with your Windows permissions. Full Desktop trust only; always asks first, and downloading code, security changes, startup entries and mass deletes are refused.',
    buildParams: (z) => z.object({
      command: z.string(),
      timeout: z.number().int().min(1).max(120).optional().describe('Seconds before it is stopped (default 30).'),
    }),
  },
  {
    name: 'windows_mcp_files', remote: 'FileSystem', kind: 'system',
    description: 'Read, write, copy, move, delete, list, search or inspect files. Full Desktop trust only; a relative path means your Desktop. Keys, passwords and system folders are off limits.',
    buildParams: (z) => z.object({
      mode: z.enum(['read', 'write', 'copy', 'move', 'delete', 'list', 'search', 'info']),
      path: z.string(),
      destination: z.string().optional().describe('For copy and move.'),
      content: z.string().optional().describe('For write.'),
      pattern: z.string().optional().describe('For search (required) and list (optional filter).'),
      recursive: bool(z, 'Include everything inside folders.'),
      append: bool(z, 'For write: add to the end instead of replacing.'),
      overwrite: bool(z, 'For copy and move: replace an existing file.'),
      offset: z.number().int().min(0).optional().describe('For read: first line.'),
      limit: z.number().int().min(1).optional().describe('For read: number of lines.'),
      encoding: z.string().optional(),
      show_hidden: bool(z, 'For list: include hidden files.'),
    }),
  },
  {
    name: 'windows_mcp_registry', remote: 'Registry', kind: 'system',
    description: 'Read the Windows registry (get, list) or change your own settings under HKCU (set, delete). Full Desktop trust only; startup, policy and HKLM changes are refused.',
    buildParams: (z) => z.object({
      mode: z.enum(['get', 'set', 'delete', 'list']),
      path: z.string().describe('For example HKCU:\\Software\\MyApp'),
      name: z.string().optional().describe('The value name (get, set; optional for delete).'),
      value: z.string().optional().describe('For set.'),
      type: z.enum(['String', 'DWord', 'QWord', 'Binary', 'MultiString', 'ExpandString']).optional(),
    }),
  },
  {
    name: 'windows_mcp_process', remote: 'Process', kind: 'system',
    description: 'List running processes, or close one by name or id. Full Desktop trust only; closing asks first, and Windows and AI Assistant themselves are protected.',
    buildParams: (z) => z.object({
      mode: z.enum(['list', 'kill']),
      name: z.string().optional(),
      pid: z.number().int().optional(),
      sort_by: z.enum(['memory', 'cpu', 'name']).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      force: bool(z, 'For kill: end it without letting it save.'),
    }),
  },
];

export const WINDOWS_MCP_CLIENT = {
  id: 'windows-mcp',
  name: 'Windows-MCP (CursorTouch)',
  description: `CursorTouch/Windows-MCP ${WINDOWS_MCP_VERSION} (uvx windows-mcp) for Windows desktop control: look, click, type, shortcuts, apps, and (at Full Desktop trust) PowerShell, files, registry and processes. Needs uv installed.`,
  type: 'builtin',
  defaultConfig: {
    command: '',
    args: `windows-mcp@${WINDOWS_MCP_VERSION} serve --transport stdio`,
  },
  tools: TOOL_SPECS.map((t) => t.name),
};

/** The uvx to run: the configured command, else where uv usually lands on Windows, else whatever PATH finds. */
export function resolveCommand(configured, { env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  if (configured && String(configured).trim()) return String(configured).trim();
  const local = env.LOCALAPPDATA;
  const found = [
    winPath.join(home, '.local', 'bin', 'uvx.exe'),
    local && winPath.join(local, 'Microsoft', 'WinGet', 'Links', 'uvx.exe'),
    local && winPath.join(local, 'Programs', 'uv', 'uvx.exe'),
    winPath.join(home, '.cargo', 'bin', 'uvx.exe'),
  ].filter(Boolean).find((p) => exists(p));
  return found ?? 'uvx';
}

/** Split an argument string on spaces, keeping "quoted parts" (paths with spaces) together. */
export function splitArgs(value) {
  if (Array.isArray(value)) return value.map(String);
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(value ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** The server's environment: ours, uv's usual folders on PATH, and its usage reporting switched off, always. */
export function buildEnv(base = process.env, home = os.homedir()) {
  const env = { ...base };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
  const extra = [winPath.join(home, '.local', 'bin'), base.LOCALAPPDATA && winPath.join(base.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')].filter(Boolean);
  env[key] = [...extra, env[key] ?? ''].filter(Boolean).join(';');
  // Windows-MCP sends anonymous usage data to PostHog unless told not to. Not configurable: nothing leaves this PC.
  env.ANONYMIZED_TELEMETRY = 'false';
  return env;
}

function formatMcpResult(res) {
  if (!res) return JSON.stringify({ ok: false, error: 'Empty response from windows-mcp' });
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  const images = content.filter((c) => c?.type === 'image' && typeof c.data === 'string');
  if (res.isError) return JSON.stringify({ ok: false, error: text.join('\n') || 'windows-mcp reported an error' });
  if (images.length) {
    return { content: [{ type: 'text', text: text.join('\n') || 'Screenshot.' }, ...images.map((i) => ({ type: 'image', mediaType: i.mimeType || 'image/png', data: i.data }))] };
  }
  if (text.length) return text.join('\n');
  return JSON.stringify(res, null, 2);
}

const asResult = (r) => (typeof r === 'string' || (r && Array.isArray(r.content)) ? r : JSON.stringify(r, null, 2));

export function createWindowsMcpTools({
  z,
  isEnabled = () => true,
  getConfig = () => ({}),
  service = null,
  platform = process.platform,
  spawnFn = spawn,
  home = os.homedir(),
  env = process.env,
  initTimeoutMs = 240_000, // the first run downloads Python and the packages
}) {
  let proc = null;
  let readyPromise = null;
  let nextId = 1;
  let stderrTail = '';
  const inflight = new Map();

  function killTree(child) {
    try {
      if (platform === 'win32' && child.pid) {
        // taskkill /T so the Python the launcher started goes too, even if we are the one being killed next.
        spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on?.('error', () => {});
      }
      child.kill();
    } catch { /* already gone */ }
  }

  function reset(reason = 'Windows-MCP connection reset.') {
    readyPromise = null;
    for (const { reject, timer } of inflight.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    inflight.clear();
    if (proc) {
      const child = proc;
      proc = null;
      killTree(child);
    }
  }

  function sendRaw(obj) {
    if (!proc || !proc.stdin?.writable) throw new Error('Windows-MCP process is not running.');
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function rpc(method, params = {}, timeoutMs = 30_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`Windows-MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      inflight.set(id, { resolve, reject, timer });
      try {
        sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        inflight.delete(id);
        reject(err);
      }
    });
  }

  async function ensureConnected() {
    if (platform !== 'win32') throw new Error('Windows-MCP is only supported on Windows.');
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const cfg = getConfig() ?? {};
      const cmd = resolveCommand(cfg.command, { env, home });
      const args = splitArgs(cfg.args ?? WINDOWS_MCP_CLIENT.defaultConfig.args);
      stderrTail = '';
      const child = spawnFn(cmd, args.length ? args : splitArgs(WINDOWS_MCP_CLIENT.defaultConfig.args), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: buildEnv(env, home),
        windowsHide: true, // no console window flashing up
      });
      proc = child;
      child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
      child.on('exit', (code) => {
        if (proc === child) reset(`Windows-MCP stopped (exit ${code}).${stderrTail ? ` ${stderrTail.trim().split('\n').pop()}` : ''}`);
      });
      child.on('error', (err) => {
        const missing = err?.code === 'ENOENT';
        if (proc === child) reset(missing
          ? 'uv is not installed (uvx not found). Install it with "winget install astral-sh.uv", then try again.'
          : `Windows-MCP could not start: ${err?.message ?? err}`);
      });
      createInterface({ input: child.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.id != null && inflight.has(msg.id)) {
          const entry = inflight.get(msg.id);
          inflight.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else entry.resolve(msg.result);
        }
      });
      await rpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ai-assistant', version: '0.2.8' },
      }, initTimeoutMs);
      sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((err) => {
      reset();
      throw err;
    });
    return readyPromise;
  }

  const blocked = (reason) => JSON.stringify({ ok: false, blocked: true, error: reason });

  async function callRemote(spec, args) {
    if (!isEnabled()) {
      return JSON.stringify({ error: 'disabled', message: 'Windows-MCP (CursorTouch) is disabled in MCP settings.' }, null, 2);
    }
    const kind = typeof spec.kind === 'function' ? spec.kind(args) : spec.kind;
    // Scrape's "sampling" asks the client's model to summarise, which this client doesn't offer: off unless asked for.
    const sent = spec.remote === 'Scrape' ? { use_sampling: false, ...args } : args;
    const invoke = async () => {
      await ensureConnected();
      const res = await rpc('tools/call', { name: spec.remote, arguments: sent }, 125_000);
      return formatMcpResult(res);
    };
    // safety.mjs looks at this exact call first: it refuses what is never fine, whatever the trust level.
    const verdict = checkWindowsSystemAction({ tool: spec.remote, args }, home);
    if (verdict.level === 'block') return blocked(verdict.reason);
    if (kind === 'system') {
      if (!service) return blocked('The trust gate is not available, so I will not run this.');
      return asResult(await service.runSystem(spec.name, verdict, invoke));
    }
    if (!service) return asResult(await invoke());
    if (kind === 'read') return asResult(await service.runRead(spec.name, 'front', invoke));
    const hasEnter = (spec.remote === 'Type' && !!args?.press_enter) ||
      (spec.remote === 'Shortcut' && /(^|\+)\s*(return|enter)\s*$/i.test(String(args?.shortcut ?? '')));
    const target = spec.remote === 'App' && args?.name ? args.name : 'front';
    return asResult(await service.runMutate(spec.name, target, hasEnter, invoke));
  }

  const tools = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.buildParams(z),
    execute: (args) => callRemote(spec, args ?? {}),
  }));

  return { tools, reset };
}
