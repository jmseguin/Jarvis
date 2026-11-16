import { existsSync } from "node:fs";
import { connect } from "node:net";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_SOCK = `${homedir()}/.config/herdr/herdr.sock`;
const DEFAULT_TIMEOUT_MS = 30000;

let clientCfg = {
  socketPath: null,
  herdrBin: "herdr",
  coreBin: "hc",
};
let resolvedSocket = null;

export function setClientConfig(cfg = {}) {
  clientCfg = {
    socketPath: cfg.socketPath || null,
    herdrBin: cfg.herdrBin || "herdr",
    coreBin: cfg.coreBin || "hc",
  };
  resolvedSocket = null;
}

function enrichedPath() {
  const home = homedir();
  const raw = process.env.PATH ?? "";
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const seen = new Set();
  const out = [];
  for (const d of [...raw.split(delimiter), ...extra]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.join(delimiter);
}

function resolveBin(name) {
  if (!name || isAbsolute(name)) return name;
  for (const dir of enrichedPath().split(delimiter)) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return name;
}

// Resolve the herdr server socket via `herdr status server --json`, falling
// back to a well-known default path if discovery fails.
export function getSocketPath() {
  if (clientCfg.socketPath) return clientCfg.socketPath;
  if (resolvedSocket) return resolvedSocket;

  try {
    const out = execFileSync(resolveBin(clientCfg.herdrBin), ["status", "server", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: enrichedPath() },
    });
    const info = JSON.parse(out.toString("utf8"));
    if (info && typeof info.socket === "string" && info.socket) {
      resolvedSocket = info.socket;
      return resolvedSocket;
    }
  } catch {
    // fall through to the default path
  }

  resolvedSocket = DEFAULT_SOCK;
  return resolvedSocket;
}

function execCore(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(
      resolveBin(clientCfg.coreBin),
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PATH: enrichedPath() } },
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(stderr?.trim() || err.message));
        }
        const text = stdout.toString("utf8").trim();
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ output: text });
        }
      }
    );
  });
}

function parseWhere(where = "") {
  const idx = where.indexOf(" / ");
  if (idx === -1) return { workspace: "default", tab: where || "unnamed" };
  return { workspace: where.slice(0, idx), tab: where.slice(idx + 3) };
}

async function callCoreFallback(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (method === "ping") {
    const ls = await execCore(["ls", "--json"], timeoutMs);
    return { ok: true, runtime: "herdr-core", terminal_count: ls.terminals?.length ?? 0 };
  }
  if (method === "workspace.list" || method === "workspace.get") {
    const ls = await execCore(["ls", "--json"], timeoutMs);
    const byWs = new Map();
    for (const t of ls.terminals ?? []) {
      const { workspace, tab } = parseWhere(t.where);
      if (!byWs.has(workspace)) byWs.set(workspace, { workspace_id: workspace, label: workspace, tabs: [] });
      byWs.get(workspace).tabs.push({ tab_id: t.address, label: tab, pane_id: t.address, agent: t.agent, agent_status: t.status, cwd: t.cwd });
    }
    const list = [...byWs.values()];
    if (method === "workspace.get") {
      const target = params.workspace_id || params.label;
      return list.find((w) => w.workspace_id === target || w.label === target) ?? list[0] ?? null;
    }
    return { workspaces: list };
  }
  if (method === "tab.list" || method === "tab.get") {
    const ls = await execCore(["ls", "--json"], timeoutMs);
    const tabs = (ls.terminals ?? []).map((t) => {
      const { workspace, tab } = parseWhere(t.where);
      return {
        tab_id: t.address,
        label: tab,
        workspace_id: workspace,
        workspace_label: workspace,
        pane_id: t.address,
        agent: t.agent,
        agent_status: t.status ?? null,
        state: t.state,
        cwd: t.cwd,
        turn: t.turn,
      };
    });
    if (method === "tab.get") {
      const id = params.tab_id || params.pane_id;
      return tabs.find((t) => t.tab_id === id || t.label === id) ?? null;
    }
    const filtered = params.workspace_id
      ? tabs.filter((t) => t.workspace_id === params.workspace_id)
      : tabs;
    return { tabs: filtered };
  }
  if (method === "pane.list") {
    const ls = await execCore(["ls", "--json"], timeoutMs);
    const panes = (ls.terminals ?? []).map((t) => {
      const { workspace, tab } = parseWhere(t.where);
      return {
        pane_id: t.address,
        workspace_id: workspace,
        tab_id: t.address,
        tab_label: tab,
        agent: t.agent,
        agent_status: t.status ?? null,
        state: t.state,
        cwd: t.cwd,
      };
    });
    return { panes };
  }
  if (method === "session.snapshot") {
    const ls = await execCore(["ls", "--json"], timeoutMs);
    const tabs = (ls.terminals ?? []).map((t) => {
      const { workspace, tab } = parseWhere(t.where);
      return { tab_id: t.address, label: tab, workspace, pane_id: t.address, agent: t.agent, agent_status: t.status ?? null, state: t.state, cwd: t.cwd };
    });
    return { runtime: "herdr-core", tabs, terminals: ls.terminals ?? [] };
  }
  if (method === "pane.get" || method === "agent.get") {
    const target = params.pane_id || params.agent_id || params.target;
    return await execCore(["get", target, "--json"], timeoutMs);
  }
  if (method === "agent.read") {
    const target = params.pane_id || params.agent_id || params.target;
    return await execCore(["read", target, "--json"], timeoutMs);
  }
  if (method === "agent.prompt" || method === "pane.send_input") {
    const target = params.pane_id || params.agent_id || params.target;
    const text = params.prompt ?? params.text ?? params.input ?? "";
    return await execCore(["send", target, text, "--json"], timeoutMs);
  }
  if (method === "agent.send_keys") {
    const target = params.pane_id || params.agent_id || params.target;
    const keys = Array.isArray(params.keys) ? params.keys : [String(params.keys ?? "enter")];
    return await execCore(["keys", target, ...keys, "--json"], timeoutMs);
  }
  if (method === "agent.wait" || method === "pane.wait_for_output") {
    const target = params.pane_id || params.agent_id || params.target;
    const args = ["wait", target];
    if (params.pattern) args.push("--output", String(params.pattern));
    args.push("--json");
    return await execCore(args, timeoutMs);
  }
  if (method === "agent.start") {
    const cmd = params.kind || params.command || params.program || "zsh";
    const args = ["run", "--bg", cmd];
    if (params.prompt) args.push(params.prompt);
    args.push("--json");
    return await execCore(args, timeoutMs);
  }
  throw new Error(`Herdr TUI socket not running (${getSocketPath()}) and method '${method}' is not supported by herdr-core (hc) fallback.`);
}

function callSocket(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = {
      id: `mcp:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      method,
      params,
    };

    const sock = connect(getSocketPath());
    let buf = Buffer.alloc(0);
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`herdr request timed out after ${timeoutMs}ms (method=${method})`));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(JSON.stringify(req) + "\n");
    });

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let nl;
      while ((nl = buf.indexOf(10)) !== -1) {
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== req.id) continue;
        if (msg.error) {
          const err = new Error(msg.error.message || "herdr error");
          err.code = msg.error.code;
          err.herdr = true;
          finish(reject, err);
        } else {
          finish(resolve, msg.result);
        }
      }
    });

    sock.on("error", (err) => {
      const e = new Error(`herdr socket error: ${err.message}`);
      e.code = err.code;
      finish(reject, e);
    });
  });
}

export async function call(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof params.timeout_ms === "number" && params.timeout_ms > timeoutMs) {
    timeoutMs = params.timeout_ms + 5000;
  }
  try {
    return await callSocket(method, params, timeoutMs);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
      return await callCoreFallback(method, params, timeoutMs);
    }
    throw err;
  }
}
