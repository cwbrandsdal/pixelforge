export type ImageProvider = "codex" | "openai";

export type GenerationProvider = ImageProvider | "local";

export type GenerationStatus = "completed" | "failed";

export type GenerationKind = "draft" | "final";

export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type OpenAiQuality = "auto" | "low" | "medium" | "high" | "standard" | "hd";

export type OpenAiFormat = "png" | "jpeg" | "webp";

export interface PixlForgeSettings {
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

export interface ReferenceFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  addedAt: string;
}

export interface PixlForgeProject {
  id: string;
  name: string;
  outputDir: string;
  referenceFiles: ReferenceFile[];
  createdAt: string;
  updatedAt: string;
}

export interface ImageGeneration {
  id: string;
  projectId: string;
  prompt: string;
  provider: GenerationProvider;
  kind: GenerationKind;
  parentGenerationId: string;
  outputPath: string;
  status: GenerationStatus;
  error: string;
  createdAt: string;
  model: string;
  size: string;
  batchId: string;
  index: number;
  summaryPath: string;
  referenceFilePaths: string[];
}

export interface PixlForgeState {
  settings: PixlForgeSettings;
  projects: PixlForgeProject[];
  activeProjectId: string;
  generations: ImageGeneration[];
}

export interface GenerateImagesRequest {
  projectId: string;
  prompt: string;
  settings: PixlForgeSettings;
}

export interface GenerateImagesResult {
  generations: ImageGeneration[];
}

export interface UpscaleImagesRequest {
  projectId: string;
  generationIds: string[];
}

export interface UpscaleImagesResult {
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
