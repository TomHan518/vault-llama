const {
  Plugin,
  ItemView,
  Notice,
  PluginSettingTab,
  Setting,
  MarkdownView,
  Modal
} = require("obsidian");

const VIEW_TYPE_OLLAMA_CHAT = "vault-llama-view";

const DEFAULT_SETTINGS = {
  baseUrl: "http://127.0.0.1:11434",
  allowRemoteBaseUrl: false,
  model: "",
  defaultScope: "none",
  temperature: 0.7,
  top_p: 0.9,
  repeat_penalty: 1.1,
  num_ctx: 4096,
  num_predict: 1024,
  contextMaxChars: 8000,
  inputFontSize: 15,
  autoGrowInput: true,
  inputMaxHeight: 220,
  sessionHistoryMax: 50,
  sendHistory: false
};

function normalizeInputFontSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.inputFontSize;
  return Math.min(24, Math.max(12, Math.round(parsed)));
}

function getInputFontSizeClass(value) {
  return `occ-input-size-${normalizeInputFontSize(value)}`;
}


function isLocalhostUrl(value) {
  try {
    const url = new URL(value);
    const host = (url.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch (e) {
    return false;
  }
}

function detectAbort(err) {
  if (!err) return false;
  const name = err.name || "";
  const msg = String(err.message || err);
  return name === "AbortError" || msg.includes("BodyStreamBuffer was aborted") || msg.includes("aborted");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // NEW-002: merge caller's signal with the timeout signal so both can abort
    const signals = [controller.signal, options.signal].filter(Boolean);
    const combined = signals.length > 1 && AbortSignal.any
      ? AbortSignal.any(signals)
      : controller.signal;
    const res = await fetch(url, { ...options, signal: combined });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function getMostRecentMarkdownView(app) {
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active) return active;
  const recent = app.workspace.getMostRecentLeaf && app.workspace.getMostRecentLeaf();
  if (recent && recent.view instanceof MarkdownView) return recent.view;
  const leaves = app.workspace.getLeavesOfType("markdown");
  for (const leaf of leaves) {
    if (leaf.view instanceof MarkdownView) return leaf.view;
  }
  return null;
}

function insertAtCursor(app, text) {
  const view = getMostRecentMarkdownView(app);
  if (!view) {
    new Notice("Open a note first.");
    return false;
  }
  const editor = view.editor;
  const cursor = editor.getCursor();
  const block = `\n\n## 🤖 AI Response\n\n${text}\n`;
  editor.replaceRange(block, cursor);
  return true;
}

function getTargetNoteName(app) {
  const view = getMostRecentMarkdownView(app);
  const file = view && view.file;
  return file ? file.basename + ".md" : "No note";
}

class ContextPreviewModal extends Modal {
  constructor(app, built, onDecision) {
    super(app);
    this.built = built;
    this.onDecision = onDecision;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Send local context?" });
    const summary = contentEl.createDiv({ cls: "occ-preview-summary" });
    summary.createDiv({ text: `Sources: ${this.built.sources.length}` });
    summary.createDiv({ text: `Total chars: ${this.built.totalChars}` });
    const list = contentEl.createEl("ul");
    for (const s of this.built.sources) {
      list.createEl("li", { text: `${s.label}: ${s.chars} chars` });
    }
    const details = contentEl.createEl("details");
    details.open = true;
    details.createEl("summary", { text: "Preview" });
    const pre = details.createEl("pre", { cls: "occ-preview-pre" });
    pre.setText(this.built.previewText || "(empty)");
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => {
        this.close();
        this.onDecision(false);
      }))
      .addButton((btn) => btn.setCta().setButtonText("Send").onClick(() => {
        this.close();
        this.onDecision(true);
      }));
  }
  onClose() {
    this.contentEl.empty();
  }
}

class OllamaChatView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.messages = [];
    this.models = [];
    this.abortController = null;
    this.selectionSnapshot = "";
    this.imeComposing = false;
    this.lastCompositionEnd = 0;
    this.scope = plugin.settings.defaultScope || "none";
    this.throttleTimer = null;
    this.chatBodyEl = null;
    this.inputEl = null;
    this.selectionPreviewEl = null;
    this.statusEl = null;
    this.modelSelectEl = null;
  }

  getViewType() { return VIEW_TYPE_OLLAMA_CHAT; }
  getDisplayText() { return "VaultLlama"; }
  getIcon() { return "bot"; }

  async onOpen() {
    this.messages = Array.isArray(this.plugin.sessionMessages) ? [...this.plugin.sessionMessages] : [];
    this.contentEl.empty();
    this.contentEl.addClass("occ-root");
    this.render();
    await this.refreshModels(true);
    this.renderMessages();
  }

  onClose() {
    // AUDIT-009: clean up timer and any in-flight stream to prevent leaks after view close
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.contentEl.empty();
  }
  render() {
    const root = this.contentEl.createDiv({ cls: "occ-panel" });

    const toolbar = root.createDiv({ cls: "occ-toolbar" });

    const scopeWrap = toolbar.createDiv({ cls: "occ-toolbar-group" });
    scopeWrap.createSpan({ text: "Scope" });
    const scopeSel = scopeWrap.createEl("select");
    [["none","Off"],["selection","Saved Selection"],["note","Current note"]].forEach(([v, label]) => {
      const opt = scopeSel.createEl("option", { text: label, value: v });
      if (v === this.scope) opt.selected = true;
    });
    scopeSel.addEventListener("change", () => {
      this.scope = scopeSel.value;
      if (this.scope === "selection") {
        this.captureSelectionSnapshot();
        if ((this.selectionSnapshot || "").trim()) {
          new Notice(`Saved selection captured (${this.selectionSnapshot.length} chars). The editor highlight may disappear after focus moves.`);
        }
      }
      this.updateStatus();
    });
    const refreshSelBtn = scopeWrap.createEl("button", { text: "Refresh", cls: "mod-muted occ-small-btn" });
    refreshSelBtn.title = "Refresh saved selection from current editor selection";
    refreshSelBtn.addEventListener("click", () => {
      this.captureSelectionSnapshot(true);
      this.updateStatus();
    });
    const clearSelBtn = scopeWrap.createEl("button", { text: "Clear", cls: "mod-muted occ-small-btn" });
    clearSelBtn.title = "Clear saved selection";
    clearSelBtn.addEventListener("click", () => {
      this.selectionSnapshot = "";
      this.updateStatus();
      new Notice("Saved selection cleared.");
    });

    const modelWrap = toolbar.createDiv({ cls: "occ-toolbar-group" });
    modelWrap.createSpan({ text: "Model" });
    this.modelSelectEl = modelWrap.createEl("select");
    this.modelSelectEl.addEventListener("change", async () => {
      this.plugin.settings.model = this.modelSelectEl.value;
      await this.plugin.saveSettings();
    });
    const refreshBtn = modelWrap.createEl("button", { text: "Refresh", cls: "mod-muted" });
    refreshBtn.addEventListener("click", async () => {
      await this.refreshModels(false);
    });

    this.statusEl = root.createDiv({ cls: "occ-status" });
    this.selectionPreviewEl = root.createDiv({ cls: "occ-selection-preview is-hidden" });
    this.updateStatus();

    this.chatBodyEl = root.createDiv({ cls: "occ-chat-body" });

    const composer = root.createDiv({ cls: "occ-composer" });
    const promptRow = composer.createDiv({ cls: "occ-prompt-row" });
    [["Explain", "Explain this clearly:\n"], ["Summarize", "Summarize this:\n"], ["Translate", "Translate this to Chinese:\n"]].forEach(([label, prefix]) => {
      const btn = promptRow.createEl("button", { text: label, cls: "mod-muted" });
      btn.addEventListener("click", () => {
        if (!this.inputEl) return;
        this.inputEl.value = prefix + this.inputEl.value;
        this.autoGrowInput();
      });
    });


    this.inputEl = composer.createEl("textarea", { cls: "occ-input" });
    this.inputEl.placeholder = "Ask Ollama...";
    this.applyInputAppearance();
    this.inputEl.addEventListener("compositionstart", () => { this.imeComposing = true; });
    this.inputEl.addEventListener("compositionend", () => {
      this.imeComposing = false;
      this.lastCompositionEnd = Date.now();
    });
    this.inputEl.addEventListener("input", () => {
      this.autoGrowInput();
    });
    this.inputEl.addEventListener("focus", () => {
      if (this.scope === "selection" && (this.selectionSnapshot || "").trim()) this.updateStatus();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      const postCompositionGuard = Date.now() - this.lastCompositionEnd < 60;
      if (this.imeComposing || e.isComposing || e.keyCode === 229 || postCompositionGuard) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    const actions = composer.createDiv({ cls: "occ-actions" });
    const sendBtn = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    sendBtn.addEventListener("click", () => this.handleSend());
    const stopBtn = actions.createEl("button", { text: "Stop", cls: "mod-muted" });
    stopBtn.addEventListener("click", () => this.stopStreaming());
  }

  applyInputAppearance() {
    if (!this.inputEl) return;
    for (let size = 12; size <= 24; size += 1) {
      this.inputEl.removeClass(`occ-input-size-${size}`);
    }
    this.inputEl.addClass(getInputFontSizeClass(this.plugin.settings.inputFontSize));
  }

  autoGrowInput() {
    if (!this.inputEl) return;
    this.applyInputAppearance();
    const minRows = 3;
    if (!this.plugin.settings.autoGrowInput) {
      this.inputEl.rows = minRows;
      this.inputEl.removeClass("occ-input-scroll");
      return;
    }
    const fontSize = normalizeInputFontSize(this.plugin.settings.inputFontSize);
    const lineHeight = Math.max(18, Math.round(fontSize * 1.6));
    const maxHeight = Math.max(lineHeight * minRows, Number(this.plugin.settings.inputMaxHeight || DEFAULT_SETTINGS.inputMaxHeight));
    const maxRows = Math.max(minRows, Math.floor(maxHeight / lineHeight));
    this.inputEl.rows = minRows;
    const measuredRows = Math.max(minRows, Math.ceil(this.inputEl.scrollHeight / lineHeight));
    this.inputEl.rows = Math.min(maxRows, measuredRows);
    if (measuredRows > maxRows) {
      this.inputEl.addClass("occ-input-scroll");
    } else {
      this.inputEl.removeClass("occ-input-scroll");
    }
  }

  stopStreaming() {
    if (this.abortController) this.abortController.abort();
  }

  captureSelectionSnapshot(showNotice=false) {
    const view = getMostRecentMarkdownView(this.app);
    if (!view) return "";
    const txt = (view.editor.getSelection() || "").trim();
    if (txt) {
      this.selectionSnapshot = txt;
      if (showNotice) new Notice(`Saved selection captured (${txt.length} chars). The editor highlight may disappear after focus moves.`);
    } else if (showNotice) {
      new Notice("No selection found.");
    }
    return this.selectionSnapshot;
  }

  updateStatus() {
    if (!this.statusEl) return;
    let text = "Local Context: OFF";
    if (this.scope === "selection") {
      const saved = (this.selectionSnapshot || "").trim();
      text = saved ? `Saved Selection: ${saved.length} chars` : "No saved selection. Select text in a note, then click Refresh.";
      if (this.selectionPreviewEl) {
        if (saved) {
          const previewLines = saved.split(/\r?\n/).slice(0, 3).join("\n");
          const suffix = saved.length > previewLines.length ? "…" : "";
          this.selectionPreviewEl.setText(`Saved Selection Preview:
${previewLines}${suffix}`);
          this.selectionPreviewEl.removeClass("is-hidden");
        } else {
          this.selectionPreviewEl.empty();
          this.selectionPreviewEl.addClass("is-hidden");
        }
      }
    } else if (this.scope === "note") {
      const view = getMostRecentMarkdownView(this.app);
      const file = view && view.file;
      text = file ? `Current note: ${file.basename}.md` : "Current note: none";
      if (this.selectionPreviewEl) {
        this.selectionPreviewEl.empty();
        this.selectionPreviewEl.addClass("is-hidden");
      }
    } else {
      if (this.selectionPreviewEl) {
        this.selectionPreviewEl.empty();
        this.selectionPreviewEl.addClass("is-hidden");
      }
    }
    this.statusEl.setText(text);
  }

  async refreshModels(silent) {
    if (!this.plugin.isBaseUrlAllowed()) {
      if (!silent) new Notice("Remote Base URL is blocked. Enable it in Advanced settings if you really need it.");
      return;
    }
    try {
      const res = await fetchWithTimeout(this.plugin.settings.baseUrl.replace(/\/+$/, "") + "/api/tags", {}, 12000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models.map((m) => m.name).filter(Boolean) : [];
      this.models = models;
      if (!this.plugin.settings.model && models[0]) {
        this.plugin.settings.model = models[0];
        await this.plugin.saveSettings();
      }
      this.renderModelSelect();
      if (!silent) new Notice("Models refreshed.");
    } catch (err) {
      console.error(err);
      if (!silent) new Notice("Failed to fetch models.");
    }
  }

  renderModelSelect() {
    if (!this.modelSelectEl) return;
    this.modelSelectEl.empty();
    const list = this.models.length ? this.models : (this.plugin.settings.model ? [this.plugin.settings.model] : []);
    for (const name of list) {
      const opt = this.modelSelectEl.createEl("option", { text: name, value: name });
      if (name === this.plugin.settings.model) opt.selected = true;
    }
  }

  renderMessages() {
    if (!this.chatBodyEl) return;
    this.chatBodyEl.empty();
    this.messages.forEach((msg) => {
      const item = this.chatBodyEl.createDiv({ cls: `occ-msg occ-msg-${msg.role}` });
      const body = item.createDiv({ cls: "occ-msg-body" });
      body.setText(msg.content || "");
      if (msg.role === "assistant") {
        item.addClass("occ-msg-assistant-wrap");
        const actions = item.createDiv({ cls: "occ-float-actions" });
        const copyBtn = actions.createEl("button", { text: "Copy", cls: "mod-muted" });
        copyBtn.title = "Copy answer";
        copyBtn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(msg.content || "");
            new Notice("Copied.");
          } catch (err) {
            console.error(err);
            new Notice("Copy failed.");
          }
        });
        const insertBtn = actions.createEl("button", { text: "Insert", cls: "mod-cta" });
        insertBtn.title = `Insert into ${getTargetNoteName(this.app)}`;
        insertBtn.addEventListener("click", () => {
          const ok = insertAtCursor(this.app, msg.content || "");
          if (ok) new Notice(`Inserted into: ${getTargetNoteName(this.app)}`);
        });
        const tag = actions.createDiv({ cls: "occ-target-tag" });
        tag.setText(getTargetNoteName(this.app));
      }
    });
    this.chatBodyEl.scrollTop = this.chatBodyEl.scrollHeight;
  }

  updateLastAssistantMessage() {
    if (!this.chatBodyEl) return;
    const cards = this.chatBodyEl.querySelectorAll(".occ-msg-assistant-wrap .occ-msg-body");
    if (!cards.length) {
      this.renderMessages();
      return;
    }
    const body = cards[cards.length - 1];
    const msg = this.messages[this.messages.length - 1];
    if (msg && msg.role === "assistant") {
      body.setText(msg.content || "");
      this.chatBodyEl.scrollTop = this.chatBodyEl.scrollHeight;
    } else {
      this.renderMessages();
    }
  }

  scheduleLastAssistantUpdate() {
    if (this.throttleTimer) clearTimeout(this.throttleTimer);
    this.throttleTimer = window.setTimeout(() => {
      this.throttleTimer = null;
      this.updateLastAssistantMessage();
    }, 90);
  }

  async buildContext() {
    const sources = [];
    if (this.scope === "selection") {
      const latest = this.captureSelectionSnapshot(false) || this.selectionSnapshot || "";
      const content = (latest || "").trim();
      if (content) {
        sources.push({ type: "selection", label: "Saved Selection", chars: content.length, content });
      }
    } else if (this.scope === "note") {
      const view = getMostRecentMarkdownView(this.app);
      const file = view && view.file;
      if (file) {
        const raw = await this.app.vault.cachedRead(file);
        const charLimit = Number(this.plugin.settings.contextMaxChars) || 8000;
        const content = raw.slice(0, charLimit);
        if (content.trim()) {
          sources.push({ type: "note", label: `Current note (${file.path})`, chars: content.length, content });
        }
      }
    }
    const totalChars = sources.reduce((a, b) => a + b.chars, 0);
    const previewText = sources.map((s) => `--- ${s.label} ---\n${s.content}`).join("\n\n");
    const injectText = sources.length ? ("\n\nUse the following local context only if it is relevant. Do not repeat metadata labels in the answer.\n\n" + sources.map((s) => `### ${s.label}\n${s.content}`).join("\n\n") + "\n") : "";
    return { sources, totalChars, previewText, injectText };
  }

  async handleSend() {
    if (!this.inputEl) return;
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;
    if (!this.plugin.isBaseUrlAllowed()) {
      new Notice("Remote Base URL is blocked. Enable it in Advanced settings if you really need it.");
      return;
    }
    if (!this.plugin.settings.model) {
      new Notice("Select a model first.");
      return;
    }

    let injectText = "";
    if (this.scope !== "none") {
      const built = await this.buildContext();
      if (!built.sources.length) {
        new Notice("No local context available for the selected scope.");
        return;
      }
      const ok = await new Promise((resolve) => {
        new ContextPreviewModal(this.app, built, resolve).open();
      });
      if (!ok) return;
      injectText = built.injectText;
    }

    const userText = injectText ? `${injectText}\n${prompt}` : prompt;
    const userMsg = { role: "user", content: prompt };
    const assistantMsg = { role: "assistant", content: "" };
    this.messages.push(userMsg, assistantMsg);
    this.plugin.lastAnswer = "";
    this.inputEl.value = "";
    this.autoGrowInput();
    this.renderMessages();
    await this.persistSession();

    // AUDIT-004: abort any in-progress stream before starting a new one
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.abortController = new AbortController();

    try {
      // AUDIT-002: optionally carry full conversation history (controlled by sendHistory setting)
      const historyMessages = this.plugin.settings.sendHistory
        ? this.messages
            .slice(0, -2)
            .filter((m) => m.content)
            .map((m) => ({ role: m.role, content: m.content }))
        : [];

      const body = {
        model: this.plugin.settings.model,
        messages: [...historyMessages, { role: "user", content: userText }],
        stream: true,
        options: {
          temperature: Number(this.plugin.settings.temperature),
          top_p: Number(this.plugin.settings.top_p),
          repeat_penalty: Number(this.plugin.settings.repeat_penalty),
          num_ctx: Number(this.plugin.settings.num_ctx),
          num_predict: Number(this.plugin.settings.num_predict)
        }
      };

      const res = await fetchWithTimeout(
        this.plugin.settings.baseUrl.replace(/\/+$/, "") + "/api/chat",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: this.abortController.signal
        },
        15000  // connection-establishment timeout; streaming continues beyond this
      );
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";
        for (const lineRaw of parts) {
          const line = lineRaw.trim();
          if (!line) continue;
          try {
            const data = JSON.parse(line);
            if (data.message && typeof data.message.content === "string") {
              assistantMsg.content += data.message.content;
              this.plugin.lastAnswer = assistantMsg.content;
              this.scheduleLastAssistantUpdate();
            }
          } catch (e) {}
        }
      }
      this.updateLastAssistantMessage();
      await this.persistSession();
    } catch (err) {
      if (detectAbort(err)) {
        assistantMsg.content = assistantMsg.content || "⏹ Generation stopped";
        this.plugin.lastAnswer = assistantMsg.content;
        this.updateLastAssistantMessage();
        await this.persistSession();
        return;
      }
      console.error(err);
      assistantMsg.content = `(error) ${String(err.message || err)}`;
      this.updateLastAssistantMessage();
      await this.persistSession();
      new Notice("Chat failed.");
    } finally {
      this.abortController = null;
    }
  }

  async persistSession() {
    const max = Number(this.plugin.settings.sessionHistoryMax || 0);
    if (max <= 0) {
      this.plugin.sessionMessages = [];
    } else {
      this.plugin.sessionMessages = this.messages.slice(-max);
    }
    // AUDIT-008: delegate all disk writes to saveSettings() to avoid concurrent saveData() races
    await this.plugin.saveSettings();
  }
}

class OllamaChatSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("General")
      .setHeading();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Local Ollama endpoint. Use a localhost URL for the safest setup.")
      .addText((text) => text.setValue(this.plugin.settings.baseUrl).onChange(async (value) => {
        this.plugin.settings.baseUrl = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Default scope")
      .setDesc("Safe default is Off.")
      .addDropdown((dd) => {
        dd.addOption("none", "Off");
        dd.addOption("selection", "Saved Selection");
        dd.addOption("note", "Current note");
        dd.setValue(this.plugin.settings.defaultScope);
        dd.onChange(async (value) => {
          this.plugin.settings.defaultScope = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Model parameters")
      .setHeading();

    new Setting(containerEl)
      .setName("Temperature")
      .addSlider((s) => s.setLimits(0, 2, 0.1).setValue(this.plugin.settings.temperature).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.temperature = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Top-p")
      .addSlider((s) => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.top_p).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.top_p = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Repeat penalty")
      .addSlider((s) => s.setLimits(0.8, 2, 0.05).setValue(this.plugin.settings.repeat_penalty).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.repeat_penalty = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Context size (num_ctx)")
      .setDesc("LLM context window size in tokens (passed to Ollama).")
      .addText((t) => t.setValue(String(this.plugin.settings.num_ctx)).onChange(async (v) => {
        this.plugin.settings.num_ctx = Number(v) || DEFAULT_SETTINGS.num_ctx;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Note context max chars")
      .setDesc("Max characters to inject from current note. Separate from num_ctx (tokens).")
      .addText((t) => t.setValue(String(this.plugin.settings.contextMaxChars)).onChange(async (v) => {
        this.plugin.settings.contextMaxChars = Number(v) || DEFAULT_SETTINGS.contextMaxChars;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Max tokens (num_predict)")
      .addText((t) => t.setValue(String(this.plugin.settings.num_predict)).onChange(async (v) => {
        this.plugin.settings.num_predict = Number(v) || DEFAULT_SETTINGS.num_predict;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Input")
      .setHeading();

    new Setting(containerEl)
      .setName("Input font size")
      .addSlider((s) => s.setLimits(12, 24, 1).setValue(this.plugin.settings.inputFontSize).setDynamicTooltip().onChange(async (v) => {
        this.plugin.settings.inputFontSize = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Auto-grow input")
      .addToggle((tg) => tg.setValue(this.plugin.settings.autoGrowInput).onChange(async (v) => {
        this.plugin.settings.autoGrowInput = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Input max height")
      .addText((t) => t.setValue(String(this.plugin.settings.inputMaxHeight)).onChange(async (v) => {
        this.plugin.settings.inputMaxHeight = Number(v) || DEFAULT_SETTINGS.inputMaxHeight;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Session history (max messages)")
      .setDesc("Set 0 to disable persistence.")
      .addText((t) => t.setValue(String(this.plugin.settings.sessionHistoryMax)).onChange(async (v) => {
        this.plugin.settings.sessionHistoryMax = Math.max(0, Number(v) || 0);
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Send conversation history to model")
      .setDesc("When enabled, all previous messages in the session are included in each request, giving the model multi-turn memory. Disable for faster single-turn responses.")
      .addToggle((tg) => tg.setValue(this.plugin.settings.sendHistory).onChange(async (v) => {
        this.plugin.settings.sendHistory = v;
        await this.plugin.saveSettings();
      }));

    const adv = containerEl.createEl("details");
    adv.createEl("summary", { text: "Advanced (use with care)" });
    new Setting(adv)
      .setName("Allow remote base URL")
      .setDesc("Disabled by default. Remote endpoints can leak prompts and context.")
      .addToggle((tg) => tg.setValue(this.plugin.settings.allowRemoteBaseUrl).onChange(async (v) => {
        this.plugin.settings.allowRemoteBaseUrl = v;
        await this.plugin.saveSettings();
      }));
  }
}

module.exports = class OllamaChatCopilotPlugin extends Plugin {
  async onload() {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded && loaded.settings ? loaded.settings : {});
    this.sessionMessages = loaded && Array.isArray(loaded.sessionMessages) ? loaded.sessionMessages : [];
    this.lastAnswer = "";

    this.registerView(VIEW_TYPE_OLLAMA_CHAT, (leaf) => new OllamaChatView(leaf, this));

    this.addRibbonIcon("bot", "Open chat", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: async () => this.activateView()
    });

    this.addCommand({
      id: "copy-last-answer",
      name: "Copy last answer",
      callback: async () => {
        if (!this.lastAnswer) {
          new Notice("No AI answer yet.");
          return;
        }
        try {
          await navigator.clipboard.writeText(this.lastAnswer);
          new Notice("Copied.");
        } catch (err) {
          console.error(err);
          new Notice("Copy failed.");
        }
      }
    });

    this.addCommand({
      id: "insert-last-answer",
      name: "Insert last answer at cursor",
      callback: () => {
        if (!this.lastAnswer) {
          new Notice("No AI answer yet.");
          return;
        }
        if (insertAtCursor(this.app, this.lastAnswer)) {
          new Notice(`Inserted into: ${getTargetNoteName(this.app)}`);
        }
      }
    });

    const quickAction = async (editor, mode) => {
      const text = (editor.getSelection() || "").trim();
      if (!text) {
        new Notice("Select text first.");
        return;
      }
      if (!this.isBaseUrlAllowed()) {
        new Notice("Remote Base URL is blocked. Enable it in Advanced settings if you really need it.");
        return;
      }
      const prompt = mode === "explain" ? `Explain this clearly:\n\n${text}` :
        mode === "summarize" ? `Summarize this clearly:\n\n${text}` :
        mode === "translate" ? `Translate this to Chinese:\n\n${text}` :
        `Rewrite this more clearly:\n\n${text}`;
      try {
        const answer = await this.simpleChat(prompt);
        if (mode === "rewrite") {
          editor.replaceSelection(answer);
          new Notice("Rewritten.");
        } else {
          const cursor = editor.getCursor();
          editor.replaceRange(`\n\n## 🤖 AI ${mode[0].toUpperCase() + mode.slice(1)}\n\n${answer}\n`, cursor);
          new Notice("Inserted.");
        }
      } catch (e) {
        console.error(e);
        new Notice("AI action failed.");
      }
    };

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      const selected = (editor.getSelection() || "").trim();
      if (!selected) return;
      menu.addItem((item) => item.setTitle("Explain with AI").setIcon("sparkles").onClick(() => quickAction(editor, "explain")));
      menu.addItem((item) => item.setTitle("Summarize with AI").setIcon("list").onClick(() => quickAction(editor, "summarize")));
      menu.addItem((item) => item.setTitle("Translate with AI").setIcon("languages").onClick(() => quickAction(editor, "translate")));
      menu.addItem((item) => item.setTitle("Rewrite with AI").setIcon("pencil").onClick(() => quickAction(editor, "rewrite")));
    }));

    this.addSettingTab(new OllamaChatSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OLLAMA_CHAT);
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_OLLAMA_CHAT)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_OLLAMA_CHAT, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  isBaseUrlAllowed() {
    if (this.settings.allowRemoteBaseUrl) return true;
    return isLocalhostUrl(this.settings.baseUrl);
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings, sessionMessages: this.sessionMessages });
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OLLAMA_CHAT);
    leaves.forEach((leaf) => {
      if (leaf.view && leaf.view instanceof OllamaChatView) {
        if (leaf.view.inputEl) {
          leaf.view.applyInputAppearance();
          leaf.view.autoGrowInput();
        }
        leaf.view.updateStatus();
      }
    });
  }

  async simpleChat(prompt) {
    if (!this.settings.model) throw new Error("No model selected.");
    const res = await fetchWithTimeout(this.settings.baseUrl.replace(/\/+$/, "") + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.settings.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
        options: {
          temperature: Number(this.settings.temperature),
          top_p: Number(this.settings.top_p),
          repeat_penalty: Number(this.settings.repeat_penalty),
          num_ctx: Number(this.settings.num_ctx),
          num_predict: Number(this.settings.num_predict)
        }
      })
    }, 18000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.message && typeof data.message.content === "string") return data.message.content;
    if (typeof data.response === "string") return data.response;
    return "";
  }
};
