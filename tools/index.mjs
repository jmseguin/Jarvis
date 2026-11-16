import { createHerdTools, HERD_MCP_CLIENT } from './herd.mjs';
import { createMacosUiTools, MACOS_UI_MCP_CLIENT } from './macos-ui/index.mjs';
import { createMacosUiService } from './macos-ui/service.mjs';
import { createMacosMcpTools, MACOS_MCP_CLIENT } from './macos-mcp.mjs';
import { createWindowsMcpTools, WINDOWS_MCP_CLIENT } from './windows-mcp.mjs';

// Windows-MCP only drives Windows, so it only shows up (and registers tools) there.
const onWindows = () => process.platform === 'win32';

export const BUILTIN_MCP_CLIENTS = [
  HERD_MCP_CLIENT,
  MACOS_UI_MCP_CLIENT,
  MACOS_MCP_CLIENT,
  ...(onWindows() ? [WINDOWS_MCP_CLIENT] : []),
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
  // Windows-MCP gets its own gate instance (the macOS one stays macOS-only), on the same trust level, approved apps
  // and prompt. It uses the hands-win helper to learn which app a click or keystroke lands in.
  const windowsMcp = onWindows()
    ? createWindowsMcpTools({
      z,
      service: createMacosUiService({
        hands,
        ask,
        openUrl,
        appControl,
        getTrustLevel: getTrustLevel ?? (() => 1),
        platforms: ['win32'],
        label: 'Windows UI control',
        isEnabled: () => isEnabled(WINDOWS_MCP_CLIENT.id),
        getConfig: () => getConfig(WINDOWS_MCP_CLIENT.id),
      }),
      isEnabled: () => isEnabled(WINDOWS_MCP_CLIENT.id),
      getConfig: () => getConfig(WINDOWS_MCP_CLIENT.id),
    })
    : { tools: [], reset() {} };
  return {
    tools: [...herd.tools, ...macosUi.tools, ...macosMcp.tools, ...windowsMcp.tools],
    service: macosUi.service,
    resetMcpClient(id) {
      if (id === HERD_MCP_CLIENT.id) herd.reset();
      if (id === MACOS_UI_MCP_CLIENT.id) macosUi.reset?.();
      if (id === MACOS_MCP_CLIENT.id) macosMcp.reset();
      if (id === WINDOWS_MCP_CLIENT.id) windowsMcp.reset();
    },
  };
}
