import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  CheckCircle2,
  Clipboard,
  Cloud,
  Copy,
  ExternalLink,
  File,
  FileImage,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Images,
  KeyRound,
  LoaderCircle,
  Maximize2,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquareCheck,
  Terminal,
  Trash2,
  Upload,
  Wand2,
  X
} from "lucide-react";
import type { ImageGeneration, PixlForgeProject, PixlForgeSettings, ReferenceFile, SecretStatus, UpdateState } from "../shared/types";
import "./styles.css";

type LogEntry = {
  timestamp: string;
  message: string;
  stream: "info" | "stdout" | "stderr" | "error";
};

type AppView = "forge" | "settings";

const emptySettings: PixlForgeSettings = {
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
  "Three clean editorial poster variants for a generative image tool named PixlForge, premium software aesthetic, no mockup UI text",
  "A friendly robot blacksmith shaping colorful image pixels on an anvil, high-end 3D illustration, navy background, lime highlights"
];
const logoUrl = new URL("../../assets/icon.png", import.meta.url).href;

function App() {
  const [settings, setSettings] = useState<PixlForgeSettings>(emptySettings);
  const [projects, setProjects] = useState<PixlForgeProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
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
  const [newProjectName, setNewProjectName] = useState("");
  const [selectedGenerationIds, setSelectedGenerationIds] = useState<string[]>([]);
  const [isUpscaling, setIsUpscaling] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [projects, activeProjectId]
  );
  const projectGenerations = useMemo(
    () => selectedProject
      ? generations.filter((generation) => generation.projectId === selectedProject.id)
      : [],
    [generations, selectedProject]
  );
  const completedGenerations = useMemo(
    () => projectGenerations.filter((generation) => generation.status === "completed" && generation.outputPath),
    [projectGenerations]
  );
  const draftGenerations = useMemo(
    () => completedGenerations.filter((generation) => generation.kind !== "final"),
    [completedGenerations]
  );
  const finalGenerations = useMemo(
    () => completedGenerations.filter((generation) => generation.kind === "final"),
    [completedGenerations]
  );
  const selectedDraftGenerations = useMemo(
    () => draftGenerations.filter((generation) => selectedGenerationIds.includes(generation.id)),
    [draftGenerations, selectedGenerationIds]
  );
  const failedGenerations = useMemo(
    () => projectGenerations.filter((generation) => generation.status === "failed"),
    [projectGenerations]
  );

  useEffect(() => {
    if (!window.pixlforge) {
      setStatus("Electron preload API was not available.");
      return;
    }

    void window.pixlforge.loadState().then((state) => {
      setSettings(state.settings);
      setProjects(state.projects);
      setActiveProjectId(state.activeProjectId);
      setGenerations(state.generations);
      return Promise.all([
        window.pixlforge.getSecretStatus(),
        window.pixlforge.getUpdateState()
      ]);
    }).then(([nextSecretStatus, nextUpdateState]) => {
      setSecretStatus(nextSecretStatus);
      setUpdateState(nextUpdateState);
    }).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });

    const removeLog = window.pixlforge.onGenerationLog((entry) => {
      setLogs((current) => [...current, entry].slice(-160));
    });
    const removeGenerationUpdate = window.pixlforge.onGenerationUpdate((payload) => {
      setGenerations(payload.generations);
      setStatus(payload.message);
    });
    const removeUpdateState = window.pixlforge.onUpdateState(setUpdateState);
    return () => {
      removeLog();
      removeGenerationUpdate();
      removeUpdateState();
    };
  }, []);

  useEffect(() => {
    const paths = [
      ...completedGenerations.map((generation) => generation.outputPath),
      ...(selectedProject?.referenceFiles.map((reference) => reference.path) ?? [])
    ];
    if (!paths.length) {
      setAssetUrls({});
      return;
    }
    let canceled = false;
    void Promise.all(paths.map(async (filePath) => {
      try {
        return [filePath, await window.pixlforge.getAssetUrl(filePath)] as const;
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
  }, [completedGenerations, selectedProject?.referenceFiles]);

  useEffect(() => {
    const draftIds = new Set(draftGenerations.map((generation) => generation.id));
    setSelectedGenerationIds((current) => current.filter((id) => draftIds.has(id)));
  }, [draftGenerations]);

  useEffect(() => {
    if (!preview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreview(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [preview]);

  async function updateSettings(patch: Partial<PixlForgeSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    try {
      const saved = await window.pixlforge.updateSettings(next);
      setSettings(saved);
      setStatus("Settings saved");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save settings");
    }
  }

  async function chooseOutputRoot() {
    const outputRoot = await window.pixlforge.chooseOutputRoot();
    if (outputRoot) {
      await updateSettings({ outputRoot });
    }
  }

  function applyState(state: { settings: PixlForgeSettings; projects: PixlForgeProject[]; activeProjectId: string; generations: ImageGeneration[] }) {
    setSettings(state.settings);
    setProjects(state.projects);
    setActiveProjectId(state.activeProjectId);
    setGenerations(state.generations);
  }

  async function selectProject(projectId: string) {
    setActiveProjectId(projectId);
    try {
      const state = await window.pixlforge.setActiveProject(projectId);
      applyState(state);
      setStatus(`Project: ${state.projects.find((project) => project.id === state.activeProjectId)?.name ?? "Selected"}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not switch project");
    }
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) {
      setStatus("Add a project name first");
      return;
    }
    try {
      const state = await window.pixlforge.createProject(name);
      applyState(state);
      setNewProjectName("");
      setStatus(`Created ${name}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create project");
    }
  }

  async function deleteSelectedProject() {
    if (!selectedProject || projects.length <= 1) return;
    try {
      const state = await window.pixlforge.deleteProject(selectedProject.id);
      applyState(state);
      setStatus("Project deleted");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not delete project");
    }
  }

  async function addReferenceFiles() {
    if (!selectedProject) return;
    try {
      const updated = await window.pixlforge.addProjectReferenceFiles(selectedProject.id);
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      setStatus("Reference files updated");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add reference files");
    }
  }

  async function removeReferenceFile(reference: ReferenceFile) {
    if (!selectedProject) return;
    try {
      const updated = await window.pixlforge.removeProjectReferenceFile(selectedProject.id, reference.id);
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      setStatus("Reference file removed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not remove reference file");
    }
  }

  async function saveOpenAiApiKey() {
    try {
      const nextStatus = await window.pixlforge.saveOpenAiApiKey(apiKeyDraft);
      setSecretStatus(nextStatus);
      setApiKeyDraft("");
      setStatus(apiKeyDraft.trim() ? "OpenAI API key saved" : "OpenAI API key cleared");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save OpenAI API key");
    }
  }

  async function clearOpenAiApiKey() {
    const nextStatus = await window.pixlforge.clearOpenAiApiKey();
    setSecretStatus(nextStatus);
    setApiKeyDraft("");
    setStatus("OpenAI API key cleared");
  }

  async function generateImages() {
    if (isGenerating || isUpscaling) return;
    if (!prompt.trim()) {
      setStatus("Add a prompt before generating images");
      return;
    }
    setIsGenerating(true);
    setLogs([]);
    setStatus("Creating drafts");
    try {
      if (!selectedProject) {
        throw new Error("Create or select a project before generating images.");
      }
      await window.pixlforge.generateImages({ projectId: selectedProject.id, prompt, settings });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setIsGenerating(false);
    }
  }

  async function deleteGeneration(generation: ImageGeneration) {
    await window.pixlforge.deleteGeneration(generation.id);
    setGenerations((current) => current.filter((candidate) => candidate.id !== generation.id));
    setSelectedGenerationIds((current) => current.filter((id) => id !== generation.id));
    if (preview?.id === generation.id) setPreview(null);
    setStatus("Image deleted");
  }

  async function copyImage(generation: ImageGeneration) {
    const copied = await window.pixlforge.copyImage(generation.outputPath);
    setStatus(copied ? "Image copied" : "Image could not be copied");
  }

  function toggleDraftSelection(generationId: string) {
    setSelectedGenerationIds((current) => current.includes(generationId)
      ? current.filter((id) => id !== generationId)
      : [...current, generationId]);
  }

  function selectAllDrafts() {
    setSelectedGenerationIds(draftGenerations.map((generation) => generation.id));
  }

  async function upscaleDrafts(generationIds: string[]) {
    if (!selectedProject || isGenerating || isUpscaling) return;
    const draftIds = new Set(draftGenerations.map((generation) => generation.id));
    const ids = generationIds.filter((id) => draftIds.has(id));
    if (!ids.length) {
      setStatus("Select one or more drafts first");
      return;
    }

    setIsUpscaling(true);
    setLogs([]);
    setStatus("Creating 4K finals");
    try {
      await window.pixlforge.upscaleImages({ projectId: selectedProject.id, generationIds: ids });
      setSelectedGenerationIds((current) => current.filter((id) => !ids.includes(id)));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upscale failed");
    } finally {
      setIsUpscaling(false);
    }
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
              <h1>PixlForge</h1>
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
            <button type="button" className="icon-button labeled" onClick={() => window.pixlforge.installUpdate()}>
              <RefreshCw size={16} />
              Restart
            </button>
          ) : (
            <button type="button" className="icon-button" title="Check for updates" onClick={() => window.pixlforge.checkForUpdates()}>
              <RefreshCw size={17} />
            </button>
          )}
          <button type="button" className="icon-button" title="Open releases" onClick={() => window.pixlforge.openReleasesPage()}>
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
          <div className="panel-section project-section">
            <div className="section-title">
              <FolderOpen size={18} />
              <h2>Project</h2>
            </div>
            <label>
              Active project
              <select value={selectedProject?.id ?? ""} onChange={(event) => void selectProject(event.target.value)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <div className="project-create-row">
              <input
                value={newProjectName}
                placeholder="New project name"
                onChange={(event) => setNewProjectName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createProject();
                }}
              />
              <button type="button" className="icon-button" title="Create project" onClick={() => void createProject()}>
                <Plus size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="Delete project"
                disabled={projects.length <= 1}
                onClick={() => void deleteSelectedProject()}
              >
                <Trash2 size={16} />
              </button>
            </div>
            {selectedProject && (
              <button type="button" className="path-button" onClick={() => void window.pixlforge.showItemInFolder(selectedProject.outputDir)}>
                <span>{selectedProject.outputDir}</span>
                <FolderOpen size={16} />
              </button>
            )}
          </div>

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
                <select value={settings.aspectRatio} onChange={(event) => void updateSettings({ aspectRatio: event.target.value as PixlForgeSettings["aspectRatio"] })}>
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

          <div className="panel-section reference-section">
            <div className="section-title">
              <FileImage size={18} />
              <h2>References</h2>
            </div>
            <button type="button" className="upload-button" disabled={!selectedProject} onClick={() => void addReferenceFiles()}>
              <Upload size={17} />
              Add files
            </button>
            <div className="reference-list">
              {selectedProject?.referenceFiles.length ? selectedProject.referenceFiles.map((reference) => (
                <div className="reference-item" key={reference.id}>
                  <div className="reference-thumb">
                    {assetUrls[reference.path] ? <img src={assetUrls[reference.path]} alt="" /> : referenceIcon(reference)}
                  </div>
                  <div>
                    <strong>{reference.name}</strong>
                    <span>{referenceFileMeta(reference)}</span>
                  </div>
                  <button type="button" title="Remove reference" onClick={() => void removeReferenceFile(reference)}>
                    <X size={14} />
                  </button>
                </div>
              )) : (
                <p className="empty-reference">No reference files attached.</p>
              )}
            </div>
          </div>

          <button className="generate-button" type="button" disabled={isGenerating || isUpscaling || !selectedProject} onClick={() => void generateImages()}>
            {isGenerating ? <LoaderCircle size={20} className="spin" /> : <Sparkles size={20} />}
            Create Drafts
          </button>
        </aside>

        <section className="results-panel">
          <div className="metrics-row">
            <Metric icon={<Images size={19} />} label="Drafts" value={String(draftGenerations.length)} />
            <Metric icon={<Maximize2 size={19} />} label="4K Finals" value={String(finalGenerations.length)} />
            <Metric icon={<AlertTriangle size={19} />} label="Failed" value={String(failedGenerations.length)} />
            <Metric icon={<KeyRound size={19} />} label="Key" value={secretStatus.openAiApiKeySaved || secretStatus.openAiApiKeyFromEnv ? "Ready" : "Missing"} />
          </div>

          <div className="gallery-toolbar">
            <div>
              <strong>{selectedDraftGenerations.length} selected</strong>
              <span>Upscale selected drafts into project-level 4K finals.</span>
            </div>
            <div className="gallery-toolbar-actions">
              <button type="button" disabled={!draftGenerations.length} onClick={selectAllDrafts}>
                <SquareCheck size={15} />
                Select drafts
              </button>
              <button type="button" disabled={!selectedGenerationIds.length} onClick={() => setSelectedGenerationIds([])}>
                <Square size={15} />
                Clear
              </button>
              <button
                type="button"
                className="upscale-action"
                disabled={!selectedDraftGenerations.length || isGenerating || isUpscaling}
                onClick={() => void upscaleDrafts(selectedDraftGenerations.map((generation) => generation.id))}
              >
                {isUpscaling ? <LoaderCircle size={16} className="spin" /> : <Maximize2 size={16} />}
                4K Upscale
              </button>
            </div>
          </div>

          <div className="gallery">
            {completedGenerations.length ? completedGenerations.map((generation) => {
              const isFinal = generation.kind === "final";
              const isSelected = selectedGenerationIds.includes(generation.id);
              return (
                <article className={`image-card ${isFinal ? "final-card" : ""}`} key={generation.id}>
                  <div className="image-preview-wrap">
                    {!isFinal && (
                      <button
                        type="button"
                        className={`select-toggle ${isSelected ? "active" : ""}`}
                        title={isSelected ? "Deselect draft" : "Select draft"}
                        onClick={() => toggleDraftSelection(generation.id)}
                      >
                        {isSelected ? <SquareCheck size={17} /> : <Square size={17} />}
                      </button>
                    )}
                    <button type="button" className="image-preview" onClick={() => setPreview(generation)}>
                      {assetUrls[generation.outputPath] ? (
                        <img src={assetUrls[generation.outputPath]} alt="" />
                      ) : (
                        <ImageIcon size={28} />
                      )}
                    </button>
                    <span className={`image-badge ${isFinal ? "final" : "draft"}`}>{isFinal ? "4K Final" : "Draft"}</span>
                  </div>
                  <div className="image-meta">
                    <strong>{generationTitle(generation)}</strong>
                    <span>{formatDate(generation.createdAt)}</span>
                  </div>
                  <p>{generation.prompt}</p>
                  <div className="card-actions">
                    {!isFinal && (
                      <button
                        type="button"
                        title="Upscale this draft to 4K"
                        disabled={isGenerating || isUpscaling}
                        onClick={() => void upscaleDrafts([generation.id])}
                      >
                        <Maximize2 size={15} />
                      </button>
                    )}
                    <button type="button" title="Copy image" onClick={() => void copyImage(generation)}><Copy size={15} /></button>
                    <button type="button" title="Show in folder" onClick={() => void window.pixlforge.showItemInFolder(generation.outputPath)}><FolderOpen size={15} /></button>
                    <button type="button" title="Open file" onClick={() => void window.pixlforge.openPath(generation.outputPath)}><ExternalLink size={15} /></button>
                    <button type="button" title="Delete image" onClick={() => void deleteGeneration(generation)}><Trash2 size={15} /></button>
                  </div>
                </article>
              );
            }) : (
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
            <div className="preview-toolbar">
              <button type="button" className="icon-button close-preview" title="Close preview" onClick={() => setPreview(null)}>
                <X size={18} />
              </button>
            </div>
            <div
              className="preview-image-stage"
              onClick={(event) => {
                if (event.target === event.currentTarget) setPreview(null);
              }}
            >
              {assetUrls[preview.outputPath] && <img src={assetUrls[preview.outputPath]} alt="" />}
            </div>
            <footer>
              <div>
                <strong>{generationTitle(preview)}</strong>
                <span>{preview.outputPath}</span>
              </div>
              <div className="card-actions">
                <button type="button" title="Close preview" onClick={() => setPreview(null)}><X size={15} /></button>
                <button type="button" title="Copy image" onClick={() => void copyImage(preview)}><Copy size={15} /></button>
                <button type="button" title="Show in folder" onClick={() => void window.pixlforge.showItemInFolder(preview.outputPath)}><FolderOpen size={15} /></button>
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

function generationTitle(generation: ImageGeneration): string {
  if (generation.kind === "final") return `4K Final #${generation.index}`;
  if (generation.provider === "codex") return `Codex Draft #${generation.index}`;
  if (generation.provider === "openai") return `OpenAI Draft #${generation.index}`;
  return `PixlForge #${generation.index}`;
}

function referenceIcon(reference: ReferenceFile): React.ReactNode {
  if (reference.mimeType.startsWith("image/")) return <FileImage size={18} />;
  if (reference.mimeType.startsWith("text/") || reference.mimeType.includes("json") || reference.mimeType.includes("xml")) {
    return <FileText size={18} />;
  }
  return <File size={18} />;
}

function referenceFileMeta(reference: ReferenceFile): string {
  return `${referenceFileType(reference)} - ${formatBytes(reference.size)}`;
}

function referenceFileType(reference: ReferenceFile): string {
  const extension = reference.name.includes(".") ? reference.name.split(".").pop()?.toUpperCase() : "";
  if (extension) return extension;
  if (reference.mimeType.startsWith("image/")) return "Image";
  if (reference.mimeType.startsWith("text/")) return "Text";
  if (reference.mimeType === "application/pdf") return "PDF";
  return "Document";
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
  settings: PixlForgeSettings;
  secretStatus: SecretStatus;
  apiKeyDraft: string;
  setApiKeyDraft: React.Dispatch<React.SetStateAction<string>>;
  updateSettings: (patch: Partial<PixlForgeSettings>) => Promise<void>;
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
          <p>Provider, API, output, and update configuration for PixlForge.</p>
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
            <select value={settings.provider} onChange={(event) => void updateSettings({ provider: event.target.value as PixlForgeSettings["provider"] })}>
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
              <select value={settings.aspectRatio} onChange={(event) => void updateSettings({ aspectRatio: event.target.value as PixlForgeSettings["aspectRatio"] })}>
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
            <select value={settings.codexReasoningEffort} onChange={(event) => void updateSettings({ codexReasoningEffort: event.target.value as PixlForgeSettings["codexReasoningEffort"] })}>
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
              <select value={settings.openAiQuality} onChange={(event) => void updateSettings({ openAiQuality: event.target.value as PixlForgeSettings["openAiQuality"] })}>
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
              <select value={settings.openAiFormat} onChange={(event) => void updateSettings({ openAiFormat: event.target.value as PixlForgeSettings["openAiFormat"] })}>
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </label>
            <label>
              Moderation
              <select value={settings.openAiModeration} onChange={(event) => void updateSettings({ openAiModeration: event.target.value as PixlForgeSettings["openAiModeration"] })}>
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

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex++;
  }
  return `${unitIndex === 0 ? Math.round(amount) : amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
