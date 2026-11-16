import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const TOOL_SPECS = [
  {
    name: 'macos_mcp_snapshot',
    remote: 'Snapshot',
    kind: 'read',
    description: 'Capture macOS desktop UI state and interactive elements via CursorTouch macOS-MCP (set use_vision=true to also include a screenshot).',
    buildParams: (z) => z.object({
      use_vision: z.boolean().optional().describe('Include screenshot image in the snapshot.'),
    }),
  },
  {
    name: 'macos_mcp_app',
    remote: 'App',
    kind: 'mutate',
    description: 'Launch, switch to, resize, or move a macOS application window via macOS-MCP.',
    buildParams: (z) => z.object({
      mode: z.enum(['launch', 'resize', 'move', 'switch']).optional().describe('Action mode (default: launch).'),
      name: z.string().nullable().optional().describe('Application name, e.g. "Google Chrome".'),
      window_loc: z.array(z.number().int()).optional().describe('Target [x, y] window position for move.'),
      window_size: z.array(z.number().int()).optional().describe('Target [width, height] for resize.'),
    }),
  },
  {
    name: 'macos_mcp_click',
    remote: 'Click',
    kind: 'mutate',
    description: 'Click at screen coordinates [x, y] via macOS-MCP.',
    buildParams: (z) => z.object({
      loc: z.array(z.number().int()).length(2).describe('Screen [x, y] coordinates to click.'),
      button: z.enum(['left', 'right', 'middle']).optional(),
      clicks: z.number().int().min(1).max(3).optional(),
    }),
  },
  {
    name: 'macos_mcp_type',
    remote: 'Type',
    kind: 'mutate',
    description: 'Click at [x, y] and type text via macOS-MCP.',
    buildParams: (z) => z.object({
      loc: z.array(z.number().int()).length(2).describe('Screen [x, y] coordinates of input.'),
      text: z.string().describe('Text to type.'),
      clear: z.boolean().optional(),
      caret_position: z.enum(['start', 'idle', 'end']).optional(),
      press_enter: z.boolean().optional(),
    }),
  },
  {
    name: 'macos_mcp_scroll',
    remote: 'Scroll',
    kind: 'mutate',
    description: 'Scroll vertically or horizontally at optional [x, y] via macOS-MCP.',
    buildParams: (z) => z.object({
      loc: z.array(z.number().int()).length(2).nullable().optional(),
      type: z.enum(['horizontal', 'vertical']).optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(),
      wheel_times: z.number().int().min(1).optional(),
    }),
  },
  {
    name: 'macos_mcp_move',
    remote: 'Move',
    kind: 'mutate',
    description: 'Move (or drag) the mouse pointer to [x, y] via macOS-MCP.',
    buildParams: (z) => z.object({
      loc: z.array(z.number().int()).length(2).describe('Target [x, y] screen coordinates.'),
      drag: z.boolean().optional(),
    }),
  },
  {
    name: 'macos_mcp_shortcut',
    remote: 'Shortcut',
    kind: 'mutate',
    description: 'Press a keyboard key or shortcut (e.g. "k", "space", "0", "cmd+c") via macOS-MCP.',
    buildParams: (z) => z.object({
      shortcut: z.string().describe('Key or shortcut string, e.g. "cmd+space", "k", "0".'),
    }),
  },
  {
    name: 'macos_mcp_wait',
    remote: 'Wait',
    kind: 'read',
    description: 'Wait for a number of seconds via macOS-MCP.',
    buildParams: (z) => z.object({
      duration: z.number().int().min(1).max(30).describe('Seconds to wait.'),
    }),
  },
  {
    name: 'macos_mcp_scrape',
    remote: 'Scrape',
    kind: 'read',
    description: 'Fetch and convert a web URL to markdown via macOS-MCP.',
    buildParams: (z) => z.object({
      url: z.string().describe('URL to scrape.'),
    }),
  },
  {
    name: 'macos_mcp_desktop',
    remote: 'Desktop',
    kind: 'mutate',
    description: 'Create/open a temporary macOS desktop view via macOS-MCP.',
    buildParams: (z) => z.object({
      mode: z.literal('create').optional(),
      close_after: z.boolean().optional(),
      open_delay: z.number().optional(),
    }),
  },
  {
    name: 'macos_mcp_notification',
    remote: 'Notification',
    kind: 'mutate',
    description: 'Show a macOS system notification via macOS-MCP.',
    buildParams: (z) => z.object({
      message: z.string(),
      title: z.string().optional(),
      subtitle: z.string().nullable().optional(),
      sound: z.string().nullable().optional(),
    }),
  },
  {
    name: 'macos_mcp_shell',
    remote: 'Shell',
    kind: 'mutate',
    description: 'Execute a shell command or osascript via macOS-MCP.',
    buildParams: (z) => z.object({
      command: z.string(),
      mode: z.enum(['shell', 'osascript']).optional(),
      timeout: z.number().int().min(1).max(120).optional(),
    }),
  },
];

export const MACOS_MCP_CLIENT = {
  id: 'macos-mcp',
  name: 'macOS-MCP (CursorTouch)',
  description: 'CursorTouch/MacOS-MCP stdio server (uvx macos-mcp serve) for native macOS UI automation, shortcuts, clicks, and AppleScript.',
  type: 'builtin',
  defaultConfig: {
    command: '',
    args: 'macos-mcp serve --transport stdio',
  },
  tools: TOOL_SPECS.map((t) => t.name),
};

function resolveCommand(configured) {
  if (configured && String(configured).trim()) return String(configured).trim();
  const homeUvx = path.join(os.homedir(), '.local', 'bin', 'uvx');
  if (fs.existsSync(homeUvx)) return homeUvx;
  if (fs.existsSync('/opt/homebrew/bin/uvx')) return '/opt/homebrew/bin/uvx';
  return 'uvx';
}

function formatMcpResult(res) {
  if (!res) return JSON.stringify({ ok: false, error: 'Empty response from macos-mcp' });
  const content = Array.isArray(res.content) ? res.content : [];
  const textParts = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text);
  if (textParts.length) {
    return res.isError ? JSON.stringify({ ok: false, error: textParts.join('\n') }) : textParts.join('\n');
  }
  return JSON.stringify(res, null, 2);
}

export function createMacosMcpTools({
  z,
  isEnabled = () => true,
  getConfig = () => ({}),
  service = null,
}) {
  let proc = null;
  let readyPromise = null;
  let nextId = 1;
  const inflight = new Map();

  function reset() {
    readyPromise = null;
    for (const { reject, timer } of inflight.values()) {
      clearTimeout(timer);
      reject(new Error('macOS-MCP connection reset.'));
    }
    inflight.clear();
    if (proc) {
      try { proc.kill(); } catch {}
      proc = null;
    }
  }

  function sendRaw(obj) {
    if (!proc || !proc.stdin?.writable) throw new Error('macOS-MCP process is not running.');
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function rpc(method, params = {}, timeoutMs = 30_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        reject(new Error(`macOS-MCP ${method} timed out after ${timeoutMs}ms`));
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
    if (process.platform !== 'darwin') {
      throw new Error('macOS-MCP is only supported on macOS.');
    }
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const cfg = getConfig() ?? {};
      const cmd = resolveCommand(cfg.command);
      const argsStr = String(cfg.args ?? MACOS_MCP_CLIENT.defaultConfig.args).trim();
      const args = argsStr ? argsStr.split(/\s+/) : ['macos-mcp', 'serve', '--transport', 'stdio'];
      const localBin = path.join(os.homedir(), '.local', 'bin');
      const env = {
        ...process.env,
        PATH: `${localBin}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}`,
      };
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      proc = child;
      child.on('exit', () => {
        if (proc === child) reset();
      });
      child.on('error', () => {
        if (proc === child) reset();
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
      }, 45_000);
      sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    })().catch((err) => {
      reset();
      throw err;
    });
    return readyPromise;
  }

  async function callRemote(spec, args) {
    if (!isEnabled()) {
      return JSON.stringify({ error: 'disabled', message: 'macOS-MCP (CursorTouch) is disabled in MCP settings.' }, null, 2);
    }
    const invoke = async () => {
      await ensureConnected();
      const res = await rpc('tools/call', { name: spec.remote, arguments: args ?? {} }, 35_000);
      return formatMcpResult(res);
    };
    if (!service) return invoke();
    if (spec.kind === 'read') {
      const r = await service.runRead(spec.name, 'front', invoke);
      return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    }
    const hasEnter = (spec.remote === 'Type' && !!args?.press_enter) ||
      (spec.remote === 'Shortcut' && /\b(return|enter)\b/i.test(String(args?.shortcut ?? '')));
    const target = spec.remote === 'App' && args?.name ? args.name : 'front';
    const r = await service.runMutate(spec.name, target, hasEnter, invoke);
    return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  }

  const tools = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.buildParams(z),
    execute: (args) => callRemote(spec, args ?? {}),
  }));

  return { tools, reset };
}
