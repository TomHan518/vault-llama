# VaultLlama

A desktop-only Obsidian plugin for chatting with a local Ollama model from a side panel.

VaultLlama is designed for a simple local workflow:
- open a chat view inside Obsidian
- select an installed Ollama model
- send prompts to your local Ollama endpoint
- copy the latest answer or insert it into the current note

## What it does

### Core features

- Sidebar chat view inside Obsidian
- Refresh and select installed Ollama models
- Streaming responses with a stop button
- Clear the current chat session from the sidebar
- Copy the latest assistant answer to the clipboard
- Insert the latest assistant answer at the current cursor position in the active note

### Available commands

- **Open chat**
- **Copy last answer**
- **Insert last answer at cursor**

### Settings

VaultLlama currently supports these settings:

- **Base URL** for the Ollama-compatible endpoint
- **Temperature**
- **Top-p**
- **Repeat penalty**
- **Context size (`num_ctx`)**
- **Max tokens (`num_predict`)**
- **Input font size**
- **Auto-grow input**
- **Input max height**
- **Send conversation history to model**
- **Allow remote base URL** (disabled by default)

## What it does not do

This version does **not** currently include:

- current note context injection
- saved selection context injection
- explain / summarize / translate / rewrite editor actions
- telemetry or analytics
- account login
- cloud sync

## Requirements

- Obsidian desktop
- Ollama installed and running
- At least one Ollama model installed locally

Default local endpoint:

- `http://127.0.0.1:11434`

The plugin is marked **desktop only** because it uses desktop-only runtime APIs.

## Installation

### Manual installation

1. Create a folder named `vault-llama` inside `.obsidian/plugins/`
2. Copy these files into that folder:
   - `manifest.json`
   - `main.js`
   - `styles.css`
3. Reload Obsidian
4. Enable **VaultLlama** in **Settings -> Community plugins**

### Community plugin release

If you publish through GitHub releases for Obsidian community submission, upload these release assets:

- `manifest.json`
- `main.js`
- `styles.css`

The release tag should match the plugin version in `manifest.json`.

## Usage

1. Start Ollama on your computer
2. Open **VaultLlama** from the ribbon icon or the **Open chat** command
3. Refresh models if the model list is empty
4. Select a model from the dropdown
5. Enter a prompt in the chat box and send it
6. Optionally:
   - stop generation while streaming
   - copy the latest answer
   - insert the latest answer into the current note

When you use **Insert last answer at cursor**, the plugin inserts a section like this into the active note:

```md
## 🤖 AI Response

<assistant answer>
```

## Privacy and network behavior

VaultLlama sends requests to an Ollama-compatible HTTP endpoint.

### Default behavior

- Default Base URL is `http://127.0.0.1:11434`
- Remote endpoints are blocked unless you explicitly enable **Allow remote base URL**
- No telemetry, ads, account system, or payment flow is included
- Plugin settings are stored using Obsidian plugin data storage

### Conversation history

If **Send conversation history to model** is enabled, previous messages from the current chat session are included in each new request.

If it is disabled, requests are sent as single-turn prompts plus the built-in system instruction.

### Important warning

If you enable a remote Base URL, your prompts and any chat history included in the request will be sent to that remote server. Review the privacy and security posture of that server before using it.

## Troubleshooting

### No models appear

- Make sure Ollama is running
- Confirm the Base URL is correct
- Use the refresh button in the chat view

### Model requests fail

- Confirm the selected model is installed in Ollama
- Check whether Ollama is reachable at the configured Base URL
- Try a smaller model if your system is low on memory

### Cannot connect to Ollama

- Confirm Ollama is listening on `127.0.0.1:11434` or your configured URL
- Check firewall or local security rules
- If you changed the Base URL to a remote host, verify that **Allow remote base URL** is enabled

### Insert does nothing

- Open a note first
- Place the cursor in the editor
- Run **Insert last answer at cursor** only after the plugin has received an answer

## Version

Current documented package version:

- `0.1.0`
