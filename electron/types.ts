export type ImageProvider = "codex" | "openai";

export type GenerationStatus = "completed" | "failed";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type OpenAiQuality = "auto" | "low" | "medium" | "high" | "standard" | "hd";

export type OpenAiFormat = "png" | "jpeg" | "webp";

export interface PixelForgeSettings {
  provider: ImageProvider;
  outputRoot: string;
  count: number;
  aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;
  openAiModel: string;
  openAiSize: string;
  openAiQuality: OpenAiQuality;
  openAiFormat: OpenAiFormat;
  openAiModeration: "auto" | "low";
  autoUpdate: boolean;
}

export interface ImageGeneration {
  id: string;
  prompt: string;
  provider: ImageProvider;
  outputPath: string;
  status: GenerationStatus;
  error: string;
  createdAt: string;
  model: string;
  size: string;
  batchId: string;
  index: number;
  summaryPath: string;
}

export interface PixelForgeState {
  settings: PixelForgeSettings;
  generations: ImageGeneration[];
}

export interface GenerateImagesRequest {
  prompt: string;
  settings: PixelForgeSettings;
}

export interface GenerateImagesResult {
  generations: ImageGeneration[];
}

export interface SecretStatus {
  openAiApiKeySaved: boolean;
  openAiApiKeyFromEnv: boolean;
  safeStorageAvailable: boolean;
}

export interface UpdateState {
  status: "idle" | "checking" | "downloading" | "ready" | "uptodate" | "error" | "dev";
  currentVersion: string;
  version: string | null;
  progress: number;
  error: string | null;
}
