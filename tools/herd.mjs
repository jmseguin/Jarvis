import rawTools from './herd-orchestrator/tools/index.js';
import { setClientConfig } from './herd-orchestrator/src/client.js';

export const HERD_MCP_CLIENT = {
  id: 'herd-orchestrator',
  name: 'Herd Orchestrator',
  description: 'Herdr workspaces, tabs, terminal panes, worktrees, and agy/agent sessions (Herdr TUI + hc Core).',
  type: 'builtin',
  defaultConfig: {
    herdrBin: 'herdr',
    coreBin: 'hc',
    socketPath: '',
  },
  tools: rawTools.map((t) => t.name),
};

function schemaToZod(z, schema) {
  if (!schema || schema.type !== 'object') return z.object({});
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, prop] of Object.entries(props)) {
    let field;
    if (prop.enum && Array.isArray(prop.enum) && prop.enum.length) {
      field = z.enum(prop.enum);
    } else if (prop.type === 'number' || prop.type === 'integer') {
      field = z.number();
    } else if (prop.type === 'boolean') {
      field = z.boolean();
    } else if (prop.type === 'array') {
      const itemType = prop.items?.type === 'number' || prop.items?.type === 'integer'
        ? z.number()
        : z.string();
      field = z.array(itemType);
    } else if (prop.type === 'object') {
      field = z.record(z.string(), z.any());
    } else {
      field = z.string();
    }
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

export function createHerdTools({ z, isEnabled = () => true, getConfig = () => ({}) }) {
  const applyConfig = () => {
    const cfg = getConfig() ?? {};
    setClientConfig({
      herdrBin: cfg.herdrBin || 'herdr',
      coreBin: cfg.coreBin || 'hc',
      socketPath: cfg.socketPath || null,
    });
  };

  const tools = rawTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: schemaToZod(z, t.inputSchema),
    execute: async (args) => {
      if (!isEnabled()) {
        return JSON.stringify({ error: 'disabled', message: 'Herd Orchestrator is disabled in MCP settings.' }, null, 2);
      }
      applyConfig();
      const result = await t.handler(args ?? {});
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    },
  }));

  return {
    tools,
    reset() {
      applyConfig();
    },
  };
}
