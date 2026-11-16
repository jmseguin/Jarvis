# AI Assistant (Jarvis)

A standalone, local-first floating desktop AI companion built with Tauri 2, a Node.js agent sidecar, macOS native voice/hands helpers, and extensible MCP tools.

### Credits & Origin

This project builds on **Roamies** by **Ken Kai**, whose visual design, companion graphics, and fantastic starting architecture made this fork possible. Watch Ken Kai's original walkthrough video here: [https://www.youtube.com/watch?v=bl9646MVDA4](https://www.youtube.com/watch?v=bl9646MVDA4).

## Project Structure

- `showcase/tauri/src-tauri/` — Tauri 2 Rust shell (`productName: "AIAssistant"`, bundle `AIAssistant.app`), tray menu, and macOS Swift helpers:
  - `voice/main.swift` — Global talk shortcut (`Option+Shift`), wake word (`Hey Jarvis`), SpeechAnalyzer / SFSpeechRecognizer, and audio engine management
  - `hands/main.swift` — macOS Accessibility & input automation (`HANDS_OFF` safety guards)
- `showcase/tauri/sidecar/` — Node.js agent brain (`sidekick.mjs`), built-in tools (`tools.mjs`), safety checks (`safety.mjs`), TTS integrations (`voicestudio.mjs`, `fish.mjs`, `gemini.mjs`), and `bundle.sh` (`esbuild` → `dist/`)
- `showcase/panel/` — Settings panel UI (`index.html`, `panel.js`, `panel.css`)
- `showcase/roamies/` — Floating overlay web UI
- `tools/` — Project-level tool and MCP source code:
  - `tools/index.mjs` — Tool registry and MCP client definitions
  - `tools/herdr.mjs` — Adapter bridging `herdr-mcp` into the sidecar tool loop
  - `tools/herdr-mcp/` — Herdr Core (`hc`) & Herdr TUI (`herdr`) integration

## VoiceStudio & TTS Setup

AI Assistant connects to [VoiceStudio](http://127.0.0.1:3900) over its local streaming WebSocket (`ws://127.0.0.1:3900/ws/tts`, configurable via `ROAMIES_VOICESTUDIO_URL` for loopback URLs) using `StudioVoice` in `showcase/tauri/sidecar/voicestudio.mjs`.

### Current VoiceStudio Configuration (Mac Studio / Apple Silicon)

- **TTS Provider in AI Assistant**: `voicestudio` (`Settings → Voice → Replies: Voice → VoiceStudio`)
- **Active VoiceStudio Engine**: `mlx-audio`
- **Active Model**: `mlx-community/Kokoro-82M-bf16` (Apple Silicon MPS)
  - *Why `mlx-audio` instead of `omnivoice`*: `omnivoice` (`k2-fsa/OmniVoice` with voice cloning) measured **11–57 seconds** to first audio chunk (`speech_first_audio` in `~/.gg/sidekick/logs/`), causing a large delay after text appeared. Switching VoiceStudio's active engine to `mlx-audio` (Kokoro) provides fast Apple Silicon MPS synthesis.
  - Note: `voicestudio.mjs` strips bracketed Fish Audio expression cues (`[warm]`, `[laughing]`, etc.) before sending text to VoiceStudio so engines do not speak cue tags aloud.

### Microphone & Wake Word Hardware Setup (Mac Studio)

- **Microphone**: External **Blue Yeti Stereo Microphone** (USB, `48000 Hz`, 2ch) set as the macOS Default Input Device.
  - *Why*: Mac Studio has no built-in microphone. Using a Bluetooth headset (`Bose QC35 II`) as the wake-listening input triggers A2DP → HFP/SCO profile switching.
- **Wake Word Behavior (`voice/main.swift`)**:
  - `AVAudioEngineConfigurationChange` during wake listening calls `scheduleAudioReconfigure()` to resume/reattach in place (with a 3-restarts-in-10s backoff guard) rather than tearing down and retrying every 5 seconds.
  - Toggling **Wake word** on resets cooldown/retry timers, requests microphone/speech authorization if needed, and starts listening immediately.

## Model & Runtime Configuration

- **Local LLM**: Configured for Ollama (e.g. `local/ollama/gemma4:latest`, `131072` context) or cloud providers (Anthropic/Claude Code, OpenAI/ChatGPT, Gemini).
- **Live State Context**: On every turn, `livePrompt()` in `showcase/tauri/sidecar/sidekick.mjs` injects `<live-state>` including currently enabled MCP servers and their tool names so the model knows which tools are active.

## Tools & MCP (`./tools`)

All custom tool and MCP source code lives in `./tools/` so it stays self-contained and easy to find.

### Herdr MCP (`tools/herdr-mcp` + `tools/herdr.mjs`)

Gives Jarvis direct visibility and control over Herdr Core (`hc`) and Herdr TUI (`herdr`) spaces, tabs, terminal panes, and running agents (including `agy` CLI sessions):

- **Tools exposed**: `herdr_skill` and `herdr`
- **Supported operations**: `list`, `get`, `read`, `send`, `wait`, `reply`, `spawn`, `close`, and raw TUI commands (empty `herdr({})` defaults to `list`).
- **GUI `PATH` enrichment**: `tools/herdr.mjs` appends `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` when resolving `hc` and `herdr` so `AIAssistant.app` finds `/Users/<user>/.local/bin/hc` even when launched from Finder/Dock/Spotlight.

### MCP Settings Pane

Open **Settings → MCP** in the panel to:
- Enable or disable individual MCP clients (stored in `config.mcpClients` in `~/.gg/sidekick.json`; disabling takes effect immediately).
- Edit a client's JSON configuration inline (e.g. `coreBinary`, `tuiBinary`, `coreSession`, `socket`, `coreSocket` for `herdr-mcp`) and apply immediately.
- Add or remove custom MCP client configurations.

## App Control & Behavior Settings

- **Settings → Apps**:
  - **Confirm before pressing Enter** (`config.confirmBeforeEnter`, default `true`)
  - **Add application** input and **Approved apps** list (seeded on first run with `iTerm2`, `Herdr`, and `Antigravity`)
- **Settings → Behavior**:
  - **Your name** (`config.userName` override; falls back to the macOS system user name when unset)
  - **Allow File Edits & Commands**, **Reminders**, and other behavior toggles

## Development, Testing & Building

### Run Sidecar Tests

```sh
cd showcase/tauri/sidecar
npm test
```

### Bundle Sidecar Only

```sh
cd showcase/tauri/sidecar
npm run build
```

### Build & Install `AIAssistant.app` (macOS)

```sh
cd showcase/tauri
TAURI_BUNDLES=app ./build.sh
rm -rf /Applications/AIAssistant.app
cp -R src-tauri/target/release/bundle/macos/AIAssistant.app /Applications/AIAssistant.app
open /Applications/AIAssistant.app
```

> Note: `TAURI_BUNDLES=app ./build.sh` builds and ad-hoc signs `AIAssistant.app`; without `TAURI_SIGNING_PRIVATE_KEY` set, the final updater `.app.tar.gz` signing step will report an error after `AIAssistant.app` is already built and signed.

### Logs & State

- Config: `~/.gg/sidekick.json`
- Sidecar logs: `~/.gg/sidekick.log` and `~/.gg/sidekick/logs/YYYY-MM-DD.log`
- Voice helper logs: `~/.gg/sidekick-voice.log`
