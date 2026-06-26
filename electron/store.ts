import { app, safeStorage } from "electron";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isSupportedReferenceFile, mimeTypeForReferenceFile } from "./reference-files.js";
import type { ImageGeneration, PixlForgeProject, PixlForgeSettings, PixlForgeState, ReferenceFile, SecretStatus } from "./types.js";

const defaultSettings: PixlForgeSettings = {
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

type SecretFile = {
  openAiApiKey?: {
    kind: "safeStorage";
    value: string;
  };
};

export class PixlForgeStore {
  private readonly dataPath: string;
  private readonly secretPath: string;
  private readonly defaultOutputRoot: string;

  constructor() {
    const userData = app.getPath("userData");
    this.dataPath = path.join(userData, "pixlforge-state.json");
    this.secretPath = path.join(userData, "pixlforge-secrets.json");
    this.defaultOutputRoot = path.join(userData, "outputs");
  }

  async load(): Promise<PixlForgeState> {
    await mkdir(this.defaultOutputRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.dataPath, "utf8")) as Partial<PixlForgeState>;
      const settings = this.normalizeSettings(parsed.settings);
      const projects = await this.normalizeProjects(parsed.projects, settings);
      const activeProjectId = projects.some((project) => project.id === parsed.activeProjectId)
        ? parsed.activeProjectId ?? projects[0].id
        : projects[0].id;
      return {
        settings,
        projects,
        activeProjectId,
        generations: (parsed.generations ?? [])
          .map((generation) => normalizeGeneration(generation, activeProjectId))
          .filter((generation): generation is ImageGeneration => Boolean(generation))
      };
    } catch {
      const settings = this.normalizeSettings(undefined);
      const project = await this.createDefaultProject(settings);
      const state: PixlForgeState = {
        settings,
        projects: [project],
        activeProjectId: project.id,
        generations: []
      };
      await this.save(state);
      return state;
    }
  }

  async save(state: PixlForgeState): Promise<void> {
    await mkdir(path.dirname(this.dataPath), { recursive: true });
    await writeFile(this.dataPath, JSON.stringify(state, null, 2), "utf8");
  }

  async updateSettings(settings: PixlForgeSettings): Promise<PixlForgeSettings> {
    const state = await this.load();
    state.settings = this.normalizeSettings(settings);
    await this.save(state);
    return state.settings;
  }

  async createProject(name: string): Promise<PixlForgeState> {
    const state = await this.load();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const projectName = name.trim() || "Untitled Project";
    const project: PixlForgeProject = {
      id,
      name: projectName,
      outputDir: path.join(state.settings.outputRoot, "projects", `${sanitizeFileName(projectName)}-${id.slice(0, 8)}`),
      referenceFiles: [],
      createdAt: now,
      updatedAt: now
    };
    await mkdir(project.outputDir, { recursive: true });
    state.projects.unshift(project);
    state.activeProjectId = project.id;
    await this.save(state);
    return state;
  }

  async updateProject(project: PixlForgeProject): Promise<PixlForgeProject> {
    const state = await this.load();
    const existing = state.projects.find((candidate) => candidate.id === project.id);
    if (!existing) throw new Error("Project not found.");
    const updated: PixlForgeProject = {
      ...existing,
      name: project.name.trim() || existing.name,
      updatedAt: new Date().toISOString()
    };
    state.projects = state.projects.map((candidate) => candidate.id === updated.id ? updated : candidate);
    await this.save(state);
    return updated;
  }

  async setActiveProject(projectId: string): Promise<PixlForgeState> {
    const state = await this.load();
    if (!state.projects.some((project) => project.id === projectId)) {
      throw new Error("Project not found.");
    }
    state.activeProjectId = projectId;
    await this.save(state);
    return state;
  }

  async deleteProject(projectId: string): Promise<PixlForgeState> {
    const state = await this.load();
    if (state.projects.length <= 1) {
      throw new Error("At least one project is required.");
    }
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found.");

    state.projects = state.projects.filter((candidate) => candidate.id !== projectId);
    state.generations = state.generations.filter((generation) => generation.projectId !== projectId);
    state.activeProjectId = state.projects[0].id;
    await this.save(state);

    const outputRoot = path.resolve(state.settings.outputRoot);
    const outputDir = path.resolve(project.outputDir);
    if (outputDir.startsWith(outputRoot + path.sep)) {
      await rm(outputDir, { recursive: true, force: true });
    }
    return state;
  }

  async addReferenceFiles(projectId: string, filePaths: string[]): Promise<PixlForgeProject> {
    const state = await this.load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found.");
    const referencesDir = path.join(project.outputDir, "references");
    await mkdir(referencesDir, { recursive: true });

    const added: ReferenceFile[] = [];
    for (const sourcePath of filePaths) {
      if (!isSupportedReferenceFile(sourcePath)) continue;
      const sourceStat = await stat(sourcePath);
      if (!sourceStat.isFile()) continue;
      const extension = path.extname(sourcePath).toLowerCase();
      const id = crypto.randomUUID();
      const name = path.basename(sourcePath);
      const targetPath = path.join(referencesDir, `${sanitizeFileName(path.basename(sourcePath, extension))}-${id.slice(0, 8)}${extension}`);
      await copyFile(sourcePath, targetPath);
      added.push({
        id,
        name,
        path: targetPath,
        mimeType: mimeTypeForReferenceFile(targetPath),
        size: sourceStat.size,
        addedAt: new Date().toISOString()
      });
    }

    const updated: PixlForgeProject = {
      ...project,
      referenceFiles: [...added, ...project.referenceFiles],
      updatedAt: new Date().toISOString()
    };
    state.projects = state.projects.map((candidate) => candidate.id === projectId ? updated : candidate);
    await this.save(state);
    return updated;
  }

  async removeReferenceFile(projectId: string, referenceId: string): Promise<PixlForgeProject> {
    const state = await this.load();
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error("Project not found.");
    const reference = project.referenceFiles.find((candidate) => candidate.id === referenceId);
    const updated: PixlForgeProject = {
      ...project,
      referenceFiles: project.referenceFiles.filter((candidate) => candidate.id !== referenceId),
      updatedAt: new Date().toISOString()
    };
    state.projects = state.projects.map((candidate) => candidate.id === projectId ? updated : candidate);
    await this.save(state);

    if (reference?.path) {
      const outputDir = path.resolve(project.outputDir);
      const referencePath = path.resolve(reference.path);
      if (referencePath.startsWith(outputDir + path.sep)) {
        await rm(referencePath, { force: true });
      }
    }
    return updated;
  }

  async addGenerations(generations: ImageGeneration[]): Promise<ImageGeneration[]> {
    const state = await this.load();
    state.generations = [...generations, ...state.generations].slice(0, 400);
    await this.save(state);
    return state.generations;
  }

  async deleteGeneration(generationId: string): Promise<string> {
    const state = await this.load();
    state.generations = state.generations.filter((generation) => generation.id !== generationId);
    await this.save(state);
    return generationId;
  }

  async getOpenAiApiKey(): Promise<string> {
    const envKey = process.env.OPENAI_API_KEY?.trim();
    if (envKey) return envKey;

    const secrets = await this.readSecrets();
    const encrypted = secrets.openAiApiKey;
    if (!encrypted) return "";
    if (encrypted.kind !== "safeStorage" || !safeStorage.isEncryptionAvailable()) return "";

    try {
      return safeStorage.decryptString(Buffer.from(encrypted.value, "base64")).trim();
    } catch {
      return "";
    }
  }

  async saveOpenAiApiKey(apiKey: string): Promise<SecretStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      await this.clearOpenAiApiKey();
      return this.getSecretStatus();
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure local key storage is not available. Set OPENAI_API_KEY in your environment instead.");
    }
    const secrets = await this.readSecrets();
    secrets.openAiApiKey = {
      kind: "safeStorage",
      value: safeStorage.encryptString(trimmed).toString("base64")
    };
    await this.writeSecrets(secrets);
    return this.getSecretStatus();
  }

  async clearOpenAiApiKey(): Promise<SecretStatus> {
    const secrets = await this.readSecrets();
    delete secrets.openAiApiKey;
    await this.writeSecrets(secrets);
    return this.getSecretStatus();
  }

  async getSecretStatus(): Promise<SecretStatus> {
    const secrets = await this.readSecrets();
    return {
      openAiApiKeySaved: Boolean(secrets.openAiApiKey),
      openAiApiKeyFromEnv: Boolean(process.env.OPENAI_API_KEY?.trim()),
      safeStorageAvailable: safeStorage.isEncryptionAvailable()
    };
  }

  private normalizeSettings(settings: Partial<PixlForgeSettings> | undefined): PixlForgeSettings {
    const merged = { ...defaultSettings, ...(settings ?? {}) };
    return {
      ...merged,
      provider: merged.provider === "openai" ? "openai" : "codex",
      outputRoot: merged.outputRoot?.trim() || this.defaultOutputRoot,
      count: clampInteger(merged.count, 1, 10, defaultSettings.count),
      aspectRatio: ["1:1", "16:9", "9:16", "4:3", "3:4"].includes(merged.aspectRatio) ? merged.aspectRatio : "1:1",
      codexReasoningEffort: ["low", "medium", "high", "xhigh"].includes(merged.codexReasoningEffort) ? merged.codexReasoningEffort : "low",
      openAiModel: merged.openAiModel?.trim() || defaultSettings.openAiModel,
      openAiSize: merged.openAiSize?.trim() || defaultSettings.openAiSize,
      openAiQuality: ["auto", "low", "medium", "high", "standard", "hd"].includes(merged.openAiQuality) ? merged.openAiQuality : "auto",
      openAiFormat: ["png", "jpeg", "webp"].includes(merged.openAiFormat) ? merged.openAiFormat : "png",
      openAiModeration: merged.openAiModeration === "low" ? "low" : "auto",
      autoUpdate: merged.autoUpdate !== false
    };
  }

  private async normalizeProjects(projects: PixlForgeProject[] | undefined, settings: PixlForgeSettings): Promise<PixlForgeProject[]> {
    const normalized = (projects ?? []).map((project) => normalizeProject(project)).filter((project): project is PixlForgeProject => Boolean(project));
    if (!normalized.length) {
      normalized.push(await this.createDefaultProject(settings));
    }
    for (const project of normalized) {
      await mkdir(project.outputDir, { recursive: true });
    }
    return normalized.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async createDefaultProject(settings: PixlForgeSettings): Promise<PixlForgeProject> {
    const now = new Date().toISOString();
    const outputDir = path.join(settings.outputRoot || this.defaultOutputRoot, "projects", "default-project");
    await mkdir(outputDir, { recursive: true });
    return {
      id: "default-project",
      name: "Default Project",
      outputDir,
      referenceFiles: [],
      createdAt: now,
      updatedAt: now
    };
  }

  private async readSecrets(): Promise<SecretFile> {
    try {
      return JSON.parse(await readFile(this.secretPath, "utf8")) as SecretFile;
    } catch {
      return {};
    }
  }

  private async writeSecrets(secrets: SecretFile): Promise<void> {
    await mkdir(path.dirname(this.secretPath), { recursive: true });
    if (!Object.keys(secrets).length) {
      await rm(this.secretPath, { force: true });
      return;
    }
    await writeFile(this.secretPath, JSON.stringify(secrets, null, 2), "utf8");
  }
}

function normalizeProject(value: Partial<PixlForgeProject>): PixlForgeProject | null {
  if (!value.id || !value.name || !value.outputDir) return null;
  const timestamp = value.updatedAt ?? value.createdAt ?? new Date().toISOString();
  return {
    id: value.id,
    name: value.name,
    outputDir: value.outputDir,
    referenceFiles: (value.referenceFiles ?? []).map(normalizeReferenceFile).filter((reference): reference is ReferenceFile => Boolean(reference)),
    createdAt: value.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function normalizeReferenceFile(value: Partial<ReferenceFile>): ReferenceFile | null {
  if (!value.id || !value.path) return null;
  return {
    id: value.id,
    name: value.name ?? path.basename(value.path),
    path: value.path,
    mimeType: value.mimeType ?? mimeTypeForReferenceFile(value.path),
    size: value.size ?? 0,
    addedAt: value.addedAt ?? new Date().toISOString()
  };
}

function normalizeGeneration(value: Partial<ImageGeneration>, fallbackProjectId: string): ImageGeneration | null {
  if (!value.id || !value.createdAt) return null;
  return {
    id: value.id,
    projectId: value.projectId ?? fallbackProjectId,
    prompt: value.prompt ?? "",
    provider: value.provider === "openai" || value.provider === "local" ? value.provider : "codex",
    kind: value.kind === "final" ? "final" : "draft",
    parentGenerationId: value.parentGenerationId ?? "",
    outputPath: value.outputPath ?? "",
    status: value.status === "failed" ? "failed" : "completed",
    error: value.error ?? "",
    createdAt: value.createdAt,
    model: value.model ?? "",
    size: value.size ?? "",
    batchId: value.batchId ?? "",
    index: value.index ?? 1,
    summaryPath: value.summaryPath ?? "",
    referenceFilePaths: value.referenceFilePaths ?? []
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "pixlforge";
}
