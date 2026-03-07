# VaultLlama

Local AI chat for Obsidian using Ollama, with explicit controls for sending local note context.

## Features

- Chat with a local Ollama model inside a sidebar view
- Refresh and select installed models
- Use local context safely:
  - Off
  - Saved selection
  - Current note
- Preview local context before it is sent
- Copy or insert the last assistant answer into a note
- Quick editor actions for explain, summarize, translate, and rewrite

## Installation

### Manual install

1. Create a folder named `vault-llama` inside `.obsidian/plugins/`
2. Copy these files into that folder:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. Reload Obsidian
4. Enable **VaultLlama** in **Settings → Community plugins**

## Usage

1. Start Ollama locally
2. Open the plugin view from the ribbon icon or the `Open chat` command
3. Refresh the model list if needed
4. Choose a scope:
   - **Off**: send only the prompt
   - **Saved selection**: send the saved editor selection after preview
   - **Current note**: send a capped slice of the current note after preview
5. Ask your question and review the answer

## Privacy and network disclosure

This plugin sends prompts to an Ollama-compatible HTTP endpoint.

- Default endpoint: `http://127.0.0.1:11434`
- The plugin is marked **desktop only**
- Remote endpoints are disabled by default
- Selected text or current note content may be sent **only when the user explicitly chooses a local context scope and confirms the preview**
- The plugin stores plugin settings and optional local session history using Obsidian plugin data storage
- No telemetry, ads, account requirement, or payment flow is included

## Release notes

For community plugin releases:

- Keep the GitHub release tag exactly equal to the plugin version
- For this package, the release tag should be: `0.1.0`
- Upload `manifest.json`, `main.js`, and `styles.css` as individual release assets
- Keep `README.md` and `versions.json` in the repository root


## Troubleshooting

- If no models appear, make sure Ollama is running and the Base URL is correct.
- If requests fail, confirm that your selected model is installed locally.
- If the plugin cannot connect to `127.0.0.1`, check firewall rules and whether Ollama is listening on the expected port.

## Remote endpoint warning

If you enable a remote endpoint, any prompt and local context you choose to send will leave your device and be transmitted to that remote server. Review that server's privacy and security controls before use.
