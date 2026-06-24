import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Cloud,
  Copy,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  Images,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import type { ImageGeneration, PixelForgeSettings, SecretStatus, UpdateState } from "../shared/types";
import "./styles.css";

type LogEntry = {
  timestamp: string;
  message: string;
  stream: "info" | "stdout" | "stderr" | "error";
};

type AppView = "forge" | "settings";

const emptySettings: PixelForgeSettings = {
  provider: "codex",
  outputRoot: "",
  count: 3,
  aspectRatio: "1:1",
  codexModel: "",
  codexReasoningEffort: "low",
  openAiModel: "gpt-image-2",
  openAiSize: "1024x1024",
  openAiQuality: "auto",
  openAiFormat: "png",
  openAiModeration: "auto",
  autoUpdate: true
};

const emptySecretStatus: SecretStatus = {
  openAiApiKeySaved: false,
  openAiApiKeyFromEnv: false,
  safeStorageAvailable: false
};

const emptyUpdateState: UpdateState = {
  status: "idle",
  currentVersion: "",
  version: null,
  progress: 0,
  error: null
};

const providerOptions = [
  { value: "codex", label: "Codex CLI" },
  { value: "openai", label: "OpenAI API" }
] as const;

const aspectRatioOptions = [
  { value: "1:1", label: "Square" },
  { value: "16:9", label: "Wide" },
  { value: "9:16", label: "Vertical" },
  { value: "4:3", label: "Classic" },
  { value: "3:4", label: "Portrait" }
] as const;

const sizeOptions = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1536x864",
  "864x1536",
  "auto"
];

const promptExamples = [
  "A cinematic product render of a compact desktop app forging pixels into a luminous image, dark workbench, lime accent light, crisp details",
  "Three clean editorial poster variants for a generative image tool named PixelForge, premium software aesthetic, no mockup UI text",
  "A friendly robot blacksmith shaping colorful image pixels on an anvil, high-end 3D illustration, navy background, lime highlights"
];
const logoUrl = new URL("../../assets/icon.png", import.meta.url).href;

function App() {
  const [settings, setSettings] = useState<PixelForgeSettings>(emptySettings);
  const [generations, setGenerations] = useState<ImageGeneration[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(emptySecretStatus);
  const [updateState, setUpdateState] = useState<UpdateState>(emptyUpdateState);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [prompt, setPrompt] = useState(promptExamples[0]);
  const [status, setStatus] = useState("Ready");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [preview, setPreview] = useState<ImageGeneration | null>(null);
  const [activeView, setActiveView] = useState<AppView>("forge");

  const completedGenerations = useMemo(
    () => generations.filter((generation) => generation.status === "completed" && generation.outputPath),
    [generations]
  );
  const failedGenerations = useMemo(
    () => generations.filter((generation) => generation.status === "failed"),
    [generations]
  );

  useEffect(() => {
    if (!window.pixelforge) {
      setStatus("Electron preload API was not available.");
      return;
    }

    void window.pixelforge.loadState().then((state) => {
      setSettings(state.settings);
      setGenerations(state.generations);
      return Promise.all([
        window.pixelforge.getSecretStatus(),
        window.pixelforge.getUpdateState()
      ]);
    }).then(([nextSecretStatus, nextUpdateState]) => {
      setSecretStatus(nextSecretStatus);
      setUpdateState(nextUpdateState);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });

    const removeLog = window.pixelforge.onGenerationLog((entry) => {
      setLogs((current) => [...current, entry].slice(-160));
    });
    const removeGenerationUpdate = window.pixelforge.onGenerationUpdate((payload) => {
      setGenerations(payload.generations);
      setStatus(payload.message);
    });
    const removeUpdateState = window.pixelforge.onUpdateState(setUpdateState);
    return () => {
      removeLog();
      removeGenerationUpdate();
      removeUpdateState();
    };
  }, []);

  useEffect(() => {
    const paths = completedGenerations.map((generation) => generation.outputPath);
    if (!paths.length) {
      setAssetUrls({});
      return;
    }
    let canceled = false;
    void Promise.all(paths.map(async (filePath) => {
      try {
        return [filePath, await window.pixelforge.getAssetUrl(filePath)] as const;
      } catch {
        return [filePath, ""] as const;
      }
    })).then((entries) => {
      if (canceled) return;
      setAssetUrls(Object.fromEntries(entries.filter(([, url]) => Boolean(url))));
    });
    return () => {
      canceled = true;
    };
  }, [completedGenerations]);

  async function updateSettings(patch: Partial<PixelForgeSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const saved = await window.pixelforge.updateSettings(next);
      setSettings(saved);
      setStatus("Settings saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save settings");
    }
  }

  async function chooseOutputRoot() {
    const outputRoot = await window.pixelforge.chooseOutputRoot();
    if (outputRoot) {
      await updateSettings({ outputRoot });
    }
  }

  async function saveOpenAiApiKey() {
    try {
      const nextStatus = await window.pixelforge.saveOpenAiApiKey(apiKeyDraft);
      setSecretStatus(nextStatus);
      setApiKeyDraft("");
      setStatus(apiKeyDraft.trim() ? "OpenAI API key saved" : "OpenAI API key cleared");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save OpenAI API key");
    }
  }

  async function clearOpenAiApiKey() {
    const nextStatus = await window.pixelforge.clearOpenAiApiKey();
    setSecretStatus(nextStatus);
    setApiKeyDraft("");
    setStatus("OpenAI API key cleared");
  }

  async function generateImages() {
    if (isGenerating) return;
    if (!prompt.trim()) {
      setStatus("Add a prompt before generating images");
      return;
    }
    setIsGenerating(true);
    setLogs([]);
    setStatus("Generating");
    try {
      await window.pixelforge.generateImages({ prompt, settings });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function deleteGeneration(generation: ImageGeneration) {
    await window.pixelforge.deleteGeneration(generation.id);
    setGenerations((current) => current.filter((candidate) => candidate.id !== generation.id));
    if (preview?.id === generation.id) setPreview(null);
    setStatus("Image deleted");
  }

  async function copyImage(generation: ImageGeneration) {
    const copied = await window.pixelforge.copyImage(generation.outputPath);
    setStatus(copied ? "Image copied" : "Image could not be copied");
  }

  function updateStatusText() {
    switch (updateState.status) {
      case "checking":
        return "Checking";
      case "downloading":
        return `Downloading ${updateState.progress}%`;
      case "ready":
        return `Update v${updateState.version} ready`;
      case "uptodate":
        return "Up to date";
      case "error":
        return updateState.error || "Update failed";
      case "dev":
        return "Dev build";
      default:
        return "Idle";
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <img src={logoUrl} alt="" />
            <div>
              <h1>PixelForge</h1>
              <span>{status}</span>
            </div>
          </div>
          <nav className="view-tabs" aria-label="Primary">
            <button
              type="button"
              className={activeView === "forge" ? "active" : ""}
              onClick={() => setActiveView("forge")}
            >
              <Sparkles size={16} />
              Forge
            </button>
            <button
              type="button"
              className={activeView === "settings" ? "active" : ""}
              onClick={() => setActiveView("settings")}
            >
              <Settings size={16} />
              Settings
            </button>
          </nav>
        </div>
        <div className="topbar-actions">
          <div className={`update-pill ${updateState.status}`}>
            <RefreshCw size={15} className={updateState.status === "checking" || updateState.status === "downloading" ? "spin" : ""} />
            <span>{updateStatusText()}</span>
          </div>
          {updateState.status === "ready" ? (
            <button type="button" className="icon-button labeled" onClick={() => window.pixelforge.installUpdate()}>
              <RefreshCw size={16} />
              Restart
            </button>
          ) : (
            <button type="button" className="icon-button" title="Check for updates" onClick={() => window.pixelforge.checkForUpdates()}>
              <RefreshCw size={17} />
            </button>
          )}
          <button type="button" className="icon-button" title="Open releases" onClick={() => window.pixelforge.openReleasesPage()}>
            <ExternalLink size={17} />
          </button>
        </div>
      </header>

      {activeView === "settings" ? (
        <SettingsView
          settings={settings}
          secretStatus={secretStatus}
          apiKeyDraft={apiKeyDraft}
          setApiKeyDraft={setApiKeyDraft}
          updateSettings={updateSettings}
          chooseOutputRoot={chooseOutputRoot}
          saveOpenAiApiKey={saveOpenAiApiKey}
          clearOpenAiApiKey={clearOpenAiApiKey}
          updateState={updateState}
        />
      ) : (
      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-section prompt-section">
            <div className="section-title">
              <Wand2 size={18} />
              <h2>Prompt</h2>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              spellCheck
            />
            <div className="prompt-buttons">
              {promptExamples.map((example, index) => (
                <button key={example} type="button" onClick={() => setPrompt(example)}>
                  {index + 1}
                </button>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">
              <Settings size={18} />
              <h2>Run</h2>
            </div>
            <div className="two-col">
              <label>
                Count
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={settings.count}
                  onChange={(event) => void updateSettings({ count: Number(event.target.value) })}
                />
              </label>
              <label>
                Shape
                <select value={settings.aspectRatio} onChange={(event) => void updateSettings({ aspectRatio: event.target.value as PixelForgeSettings["aspectRatio"] })}>
                  {aspectRatioOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>
            <div className="run-summary">
              <span>{settings.provider === "codex" ? "Codex CLI" : "OpenAI API"}</span>
              <button type="button" onClick={() => setActiveView("settings")}>
                <Settings size={15} />
                Settings
              </button>
            </div>
          </div>

          <button className="generate-button" type="button" disabled={isGenerating} onClick={() => void generateImages()}>
            {isGenerating ? <LoaderCircle size={20} className="spin" /> : <Sparkles size={20} />}
            Generate
          </button>
        </aside>

        <section className="results-panel">
          <div className="metrics-row">
            <Metric icon={<Images size={19} />} label="Saved" value={String(completedGenerations.length)} />
            <Metric icon={<AlertTriangle size={19} />} label="Failed" value={String(failedGenerations.length)} />
            <Metric icon={<KeyRound size={19} />} label="Key" value={secretStatus.openAiApiKeySaved || secretStatus.openAiApiKeyFromEnv ? "Ready" : "Missing"} />
          </div>

          <div className="gallery">
            {completedGenerations.length ? completedGenerations.map((generation) => (
              <article className="image-card" key={generation.id}>
                <button type="button" className="image-preview" onClick={() => setPreview(generation)}>
                  {assetUrls[generation.outputPath] ? (
                    <img src={assetUrls[generation.outputPath]} alt="" />
                  ) : (
                    <ImageIcon size={28} />
                  )}
                </button>
                <div className="image-meta">
                  <strong>{generation.provider === "codex" ? "Codex" : "OpenAI"} #{generation.index}</strong>
                  <span>{formatDate(generation.createdAt)}</span>
                </div>
                <p>{generation.prompt}</p>
                <div className="card-actions">
                  <button type="button" title="Copy image" onClick={() => void copyImage(generation)}><Copy size={15} /></button>
                  <button type="button" title="Show in folder" onClick={() => void window.pixelforge.showItemInFolder(generation.outputPath)}><FolderOpen size={15} /></button>
                  <button type="button" title="Open file" onClick={() => void window.pixelforge.openPath(generation.outputPath)}><ExternalLink size={15} /></button>
                  <button type="button" title="Delete image" onClick={() => void deleteGeneration(generation)}><Trash2 size={15} /></button>
                </div>
              </article>
            )) : (
              <div className="empty-gallery">
                <ImageIcon size={42} />
                <strong>No images yet</strong>
                <span>Generated images will appear here.</span>
              </div>
            )}
          </div>
        </section>

        <aside className="log-panel">
          <div className="section-title">
            <Clipboard size={18} />
            <h2>Run Log</h2>
          </div>
          <div className="log-list">
            {logs.length ? logs.map((entry, index) => (
              <div className={`log-entry ${entry.stream}`} key={`${entry.timestamp}-${index}`}>
                <time>{formatTime(entry.timestamp)}</time>
                <span>{entry.message}</span>
              </div>
            )) : (
              <div className="empty-log">
                <CheckCircle2 size={24} />
                <span>Waiting for a run.</span>
              </div>
            )}
          </div>
        </aside>
      </section>
      )}

      {preview && (
        <div className="preview-modal" onClick={() => setPreview(null)}>
          <div className="preview-content" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="icon-button close-preview" onClick={() => setPreview(null)}>
              <X size={18} />
            </button>
            {assetUrls[preview.outputPath] && <img src={assetUrls[preview.outputPath]} alt="" />}
            <footer>
              <div>
                <strong>{preview.provider === "codex" ? "Codex CLI" : preview.model}</strong>
                <span>{preview.outputPath}</span>
              </div>
              <div className="card-actions">
                <button type="button" title="Copy image" onClick={() => void copyImage(preview)}><Copy size={15} /></button>
                <button type="button" title="Show in folder" onClick={() => void window.pixelforge.showItemInFolder(preview.outputPath)}><FolderOpen size={15} /></button>
              </div>
            </footer>
          </div>
        </div>
      )}
    </main>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SettingsView({
  settings,
  secretStatus,
  apiKeyDraft,
  setApiKeyDraft,
  updateSettings,
  chooseOutputRoot,
  saveOpenAiApiKey,
  clearOpenAiApiKey,
  updateState
}: {
  settings: PixelForgeSettings;
  secretStatus: SecretStatus;
  apiKeyDraft: string;
  setApiKeyDraft: React.Dispatch<React.SetStateAction<string>>;
  updateSettings: (patch: Partial<PixelForgeSettings>) => Promise<void>;
  chooseOutputRoot: () => Promise<void>;
  saveOpenAiApiKey: () => Promise<void>;
  clearOpenAiApiKey: () => Promise<void>;
  updateState: UpdateState;
}) {
  const keyState = secretStatus.openAiApiKeyFromEnv
    ? "Using OPENAI_API_KEY"
    : secretStatus.openAiApiKeySaved
      ? "Saved locally"
      : "Not configured";

  return (
    <section className="settings-page">
      <div className="settings-heading">
        <div>
          <h2>Settings</h2>
          <p>Provider, API, output, and update configuration for PixelForge.</p>
        </div>
        <div className="settings-state">
          <ShieldCheck size={18} />
          <span>{keyState}</span>
        </div>
      </div>

      <div className="settings-grid-page">
        <section className="settings-card">
          <div className="settings-card-header">
            <Settings size={19} />
            <h3>Default Generator</h3>
          </div>
          <label>
            Provider
            <select value={settings.provider} onChange={(event) => void updateSettings({ provider: event.target.value as PixelForgeSettings["provider"] })}>
              {providerOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <div className="two-col">
            <label>
              Count
              <input
                type="number"
                min={1}
                max={10}
                value={settings.count}
                onChange={(event) => void updateSettings({ count: Number(event.target.value) })}
              />
            </label>
            <label>
              Shape
              <select value={settings.aspectRatio} onChange={(event) => void updateSettings({ aspectRatio: event.target.value as PixelForgeSettings["aspectRatio"] })}>
                {aspectRatioOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="settings-card">
          <div className="settings-card-header">
            <Terminal size={19} />
            <h3>Codex CLI</h3>
          </div>
          <label>
            Model override
            <input
              value={settings.codexModel}
              placeholder="Optional"
              onChange={(event) => void updateSettings({ codexModel: event.target.value })}
            />
          </label>
          <label>
            Reasoning
            <select value={settings.codexReasoningEffort} onChange={(event) => void updateSettings({ codexReasoningEffort: event.target.value as PixelForgeSettings["codexReasoningEffort"] })}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
          </label>
        </section>

        <section className="settings-card wide">
          <div className="settings-card-header">
            <Cloud size={19} />
            <h3>OpenAI API</h3>
          </div>
          <label>
            API key
            <div className="key-row settings-key-row">
              <input
                value={apiKeyDraft}
                type="password"
                placeholder={secretStatus.openAiApiKeyFromEnv ? "Using OPENAI_API_KEY" : secretStatus.openAiApiKeySaved ? "Saved locally" : "sk-..."}
                onChange={(event) => setApiKeyDraft(event.target.value)}
              />
              <button type="button" className="icon-button" title="Save API key" onClick={() => void saveOpenAiApiKey()}>
                <Save size={16} />
              </button>
              <button type="button" className="icon-button" title="Clear saved API key" onClick={() => void clearOpenAiApiKey()}>
                <X size={16} />
              </button>
            </div>
          </label>
          <p className="settings-note">
            Keys are stored in Electron user data with safeStorage when available. They are not written to the repository.
          </p>
          <div className="settings-openai-grid">
            <label>
              Model
              <input value={settings.openAiModel} onChange={(event) => void updateSettings({ openAiModel: event.target.value })} />
            </label>
            <label>
              Size
              <select value={settings.openAiSize} onChange={(event) => void updateSettings({ openAiSize: event.target.value })}>
                {sizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <label>
              Quality
              <select value={settings.openAiQuality} onChange={(event) => void updateSettings({ openAiQuality: event.target.value as PixelForgeSettings["openAiQuality"] })}>
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="standard">Standard</option>
                <option value="hd">HD</option>
              </select>
            </label>
            <label>
              Format
              <select value={settings.openAiFormat} onChange={(event) => void updateSettings({ openAiFormat: event.target.value as PixelForgeSettings["openAiFormat"] })}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </label>
            <label>
              Moderation
              <select value={settings.openAiModeration} onChange={(event) => void updateSettings({ openAiModeration: event.target.value as PixelForgeSettings["openAiModeration"] })}>
                <option value="auto">Auto</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
        </section>

        <section className="settings-card wide">
          <div className="settings-card-header">
            <FolderOpen size={19} />
            <h3>Output And Updates</h3>
          </div>
          <button type="button" className="path-button" onClick={() => void chooseOutputRoot()}>
            <span>{settings.outputRoot || "Choose folder"}</span>
            <FolderOpen size={16} />
          </button>
          <div className="settings-row">
            <label className="toggle-row">
              <span>Auto updates</span>
              <input
                type="checkbox"
                checked={settings.autoUpdate}
                onChange={(event) => void updateSettings({ autoUpdate: event.target.checked })}
              />
            </label>
            <div className={`update-pill ${updateState.status}`}>
              <RefreshCw size={15} className={updateState.status === "checking" || updateState.status === "downloading" ? "spin" : ""} />
              <span>v{updateState.currentVersion || "0.0.0"}</span>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
