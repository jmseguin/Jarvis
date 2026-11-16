import { createHerdTools, HERD_MCP_CLIENT } from './herd.mjs';
import { createMacosUiTools, MACOS_UI_MCP_CLIENT } from './macos-ui/index.mjs';
import { createMacosMcpTools, MACOS_MCP_CLIENT } from './macos-mcp.mjs';

export const BUILTIN_MCP_CLIENTS = [
  HERD_MCP_CLIENT,
  MACOS_UI_MCP_CLIENT,
  MACOS_MCP_CLIENT,
];

/**
 * Creates all project-level Jarvis tools under ./tools.
 */
export function createJarvisTools({
  z,
  isEnabled = () => true,
  getConfig = () => ({}),
  hands = null,
  ask = null,
  openUrl = null,
  appControl = null,
  getTrustLevel = null,
}) {
  const herd = createHerdTools({
    z,
    isEnabled: () => isEnabled(HERD_MCP_CLIENT.id),
    getConfig: () => getConfig(HERD_MCP_CLIENT.id),
  });
  const macosUi = createMacosUiTools({
    z,
    hands,
    ask,
    openUrl,
    appControl,
    getTrustLevel,
    isEnabled: () => isEnabled(MACOS_UI_MCP_CLIENT.id),
    getConfig: () => getConfig(MACOS_UI_MCP_CLIENT.id),
  });
  const macosMcp = createMacosMcpTools({
    z,
    service: macosUi.service,
    isEnabled: () => isEnabled(MACOS_MCP_CLIENT.id),
    getConfig: () => getConfig(MACOS_MCP_CLIENT.id),
  });
  return {
    tools: [...herd.tools, ...macosUi.tools, ...macosMcp.tools],
    service: macosUi.service,
    resetMcpClient(id) {
      if (id === HERD_MCP_CLIENT.id) herd.reset();
      if (id === MACOS_UI_MCP_CLIENT.id) macosUi.reset?.();
      if (id === MACOS_MCP_CLIENT.id) macosMcp.reset();
    },
  };
}
