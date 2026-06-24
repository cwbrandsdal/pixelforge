import { app, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageGeneration, PixelForgeSettings, PixelForgeState, SecretStatus } from "./types.js";

const defaultSettings: PixelForgeSettings = {
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

export class PixelForgeStore {
  private readonly dataPath: string;
  private readonly secretPath: string;
  private readonly defaultOutputRoot: string;

  constructor() {
    const userData = app.getPath("userData");
    this.dataPath = path.join(userData, "pixelforge-state.json");
    this.secretPath = path.join(userData, "pixelforge-secrets.json");
    this.defaultOutputRoot = path.join(userData, "outputs");
  }

  async load(): Promise<PixelForgeState> {
    await mkdir(this.defaultOutputRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.dataPath, "utf8")) as Partial<PixelForgeState>;
      return {
        settings: this.normalizeSettings(parsed.settings),
        generations: (parsed.generations ?? []).map(normalizeGeneration).filter((generation): generation is ImageGeneration => Boolean(generation))
      };
    } catch {
      const state: PixelForgeState = {
        settings: this.normalizeSettings(undefined),
        generations: []
      };
      await this.save(state);
      return state;
    }
  }

  async save(state: PixelForgeState): Promise<void> {
    await mkdir(path.dirname(this.dataPath), { recursive: true });
    await writeFile(this.dataPath, JSON.stringify(state, null, 2), "utf8");
  }

  async updateSettings(settings: PixelForgeSettings): Promise<PixelForgeSettings> {
    const state = await this.load();
    state.settings = this.normalizeSettings(settings);
    await this.save(state);
    return state.settings;
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

  private normalizeSettings(settings: Partial<PixelForgeSettings> | undefined): PixelForgeSettings {
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

function normalizeGeneration(value: Partial<ImageGeneration>): ImageGeneration | null {
  if (!value.id || !value.createdAt) return null;
  return {
    id: value.id,
    prompt: value.prompt ?? "",
    provider: value.provider === "openai" ? "openai" : "codex",
    outputPath: value.outputPath ?? "",
    status: value.status === "failed" ? "failed" : "completed",
    error: value.error ?? "",
    createdAt: value.createdAt,
    model: value.model ?? "",
    size: value.size ?? "",
    batchId: value.batchId ?? "",
    index: value.index ?? 1,
    summaryPath: value.summaryPath ?? ""
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
