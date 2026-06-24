import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PixelForgeStore } from "./store.js";
import type {
  GenerateImagesRequest,
  GenerateImagesResult,
  ImageGeneration,
  PixelForgeSettings,
  UpdateState
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isDev = !app.isPackaged;
const devRendererPort = Number(process.env.PIXELFORGE_DEV_RENDERER_PORT || "17851");
const releaseUrl = "https://github.com/cwbrandsdal/pixelforge/releases";
const updateCheckIntervalMs = 4 * 60 * 60 * 1000;

const store = new PixelForgeStore();
const assetTokens = new Map<string, string>();
let mainWindow: BrowserWindow | null = null;
let assetServer: Server | null = null;
let assetServerPort = 0;
let updateReadyVersion = "";
let updater: any = null;
let updateStartTimer: NodeJS.Timeout | null = null;
let updateIntervalTimer: NodeJS.Timeout | null = null;
let updateState: UpdateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  version: null,
  progress: 0,
  error: null
};

const mimeTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    title: "PixelForge",
    backgroundColor: "#101214",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isExternalHttpUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    await mainWindow.loadURL(`http://127.0.0.1:${devRendererPort}`);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist-renderer/index.html"));
  }
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function startAssetServer(): Promise<void> {
  if (assetServer) return;
  assetServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const [, route, token] = url.pathname.split("/");
    const filePath = route === "asset" && token ? assetTokens.get(token) : undefined;
    if (!filePath || !existsSync(filePath) || !isImagePath(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Content-Length": statSync(filePath).size,
      "Cache-Control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    assetServer?.once("error", reject);
    assetServer?.listen(0, "127.0.0.1", () => {
      const address = assetServer?.address();
      assetServerPort = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
}

function tokenForAsset(filePath: string): string {
  const token = createHash("sha256").update(filePath).digest("hex").slice(0, 24);
  assetTokens.set(token, filePath);
  return token;
}

function emitGenerationLog(
  sender: Electron.WebContents,
  message: string,
  stream: "info" | "stdout" | "stderr" | "error" = "info"
): void {
  sender.send("generation:log", {
    timestamp: new Date().toISOString(),
    message,
    stream
  });
}

function findOnPath(commandName: string): string | null {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const candidates = [
        path.join(entry, `${commandName}${extension.toLowerCase()}`),
        path.join(entry, `${commandName}${extension.toUpperCase()}`)
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function shouldRunThroughShell(commandPath: string): boolean {
  return process.platform === "win32" && [".cmd", ".bat"].includes(path.extname(commandPath).toLowerCase());
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "pixelforge";
}

function isImagePath(filePath: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(path.extname(filePath).toLowerCase());
}

function normalizeCodexReasoningEffort(value: PixelForgeSettings["codexReasoningEffort"]): PixelForgeSettings["codexReasoningEffort"] {
  return value === "medium" || value === "high" || value === "xhigh" ? value : "low";
}

function sizeForAspectRatio(aspectRatio: PixelForgeSettings["aspectRatio"]): string {
  if (aspectRatio === "16:9") return "1536x864";
  if (aspectRatio === "9:16") return "864x1536";
  if (aspectRatio === "4:3") return "1536x1152";
  if (aspectRatio === "3:4") return "1152x1536";
  return "1024x1024";
}

function buildCodexImagePrompt(prompt: string, settings: PixelForgeSettings): string {
  const count = Math.max(1, Math.min(10, Math.floor(settings.count)));
  const variants = Array.from({ length: count }, (_value, index) => {
    const variant = index + 1;
    return `Variant ${variant}: Change composition, crop, lighting, color balance, foreground/background hierarchy, and focal emphasis while preserving the user's subject and constraints.`;
  }).join("\n");

  return [
    "$imagegen",
    "",
    `Generate ${count} separate PixelForge image${count === 1 ? "" : "s"} from this prompt.`,
    "",
    "Important execution rule: make one separate built-in image generation call per variant. Do not use one image as the answer for multiple variants.",
    `Target aspect ratio: ${settings.aspectRatio}.`,
    `Suggested pixel size: ${sizeForAspectRatio(settings.aspectRatio)}.`,
    "",
    "User prompt:",
    prompt.trim(),
    "",
    "Variant directions:",
    variants,
    "",
    "Requirements:",
    "- Preserve explicit subject, style, text, brand, and composition constraints from the user prompt.",
    "- Make each variant meaningfully different, not a minor recolor or tiny crop change.",
    "- Avoid watermarks, UI chrome, unreadable text, and unrelated visual elements.",
    "- Generate only the requested images using the built-in image generation tool.",
    "- Do not run shell commands, PowerShell, Python, or filesystem searches.",
    "- Do not inspect CODEX_HOME or generated_images.",
    "- Do not copy, move, rename, inspect, or save files manually. PixelForge will collect the generated images after this run.",
    "- After all images are generated, reply with only: GENERATED"
  ].join("\n");
}

async function runCodexGeneration(
  prompt: string,
  settings: PixelForgeSettings,
  emitLog: (message: string, stream?: "info" | "stdout" | "stderr" | "error") => void
): Promise<ImageGeneration[]> {
  const codexPath = findOnPath("codex");
  if (!codexPath) {
    throw new Error("codex CLI was not found on PATH.");
  }

  const count = Math.max(1, Math.min(10, Math.floor(settings.count)));
  const createdAt = new Date().toISOString();
  const batchId = randomUUID();
  const batchStamp = createdAt.replace(/[:.]/g, "-");
  const outputDir = path.join(settings.outputRoot, "codex", batchStamp);
  const summaryPath = path.join(outputDir, "codex-summary.md");
  const jobStartedAt = new Date();
  await mkdir(outputDir, { recursive: true });

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "workspace-write",
    "--color",
    "never",
    "-c",
    `model_reasoning_effort="${normalizeCodexReasoningEffort(settings.codexReasoningEffort)}"`,
    "--cd",
    outputDir,
    "--output-last-message",
    summaryPath
  ];

  if (settings.codexModel.trim()) {
    args.push("--model", settings.codexModel.trim());
  }
  args.push("-");

  emitLog(`Starting Codex batch for ${count} image${count === 1 ? "" : "s"}.`);
  emitLog(`Codex CLI: ${codexPath}`);
  emitLog(`Output: ${outputDir}`);
  emitLog(`Reasoning effort: ${normalizeCodexReasoningEffort(settings.codexReasoningEffort)}.`);

  return new Promise<ImageGeneration[]>((resolve) => {
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let lastError = "";
    let sessionId = "";

    const flushLine = (stream: "stdout" | "stderr", value: string) => {
      const line = value.trim();
      if (!line) return;
      if (stream === "stderr") lastError = line;
      const sessionMatch = /session id:\s*([a-z0-9-]+)/i.exec(line);
      if (sessionMatch?.[1]) sessionId = sessionMatch[1];
      emitLog(`[codex] ${line}`, stream);
    };
    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const next = (stream === "stdout" ? stdoutRemainder : stderrRemainder) + chunk.toString("utf8");
      const lines = next.split(/\r?\n/);
      if (stream === "stdout") stdoutRemainder = lines.pop() ?? "";
      else stderrRemainder = lines.pop() ?? "";
      for (const line of lines) flushLine(stream, line);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(codexPath, args, {
        cwd: outputDir,
        env: { ...process.env },
        shell: shouldRunThroughShell(codexPath),
        windowsHide: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitLog(`Codex failed to start: ${message}`, "error");
      resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, message));
      return;
    }

    child.stdin?.end(buildCodexImagePrompt(prompt, settings));
    child.stdout?.on("data", (chunk: Buffer) => handleChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => handleChunk("stderr", chunk));
    child.on("error", (error) => {
      emitLog(`Codex failed to start: ${error.message}`, "error");
      resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, error.message));
    });
    child.on("close", async (code) => {
      flushLine("stdout", stdoutRemainder);
      flushLine("stderr", stderrRemainder);
      if (code !== 0) {
        const error = lastError || `Codex exited with code ${code ?? "unknown"}.`;
        emitLog(error, "error");
        resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, error));
        return;
      }

      const generatedImages = await findGeneratedImages(sessionId, jobStartedAt, count);
      const results: ImageGeneration[] = [];
      for (let index = 1; index <= count; index++) {
        const generatedImage = generatedImages[index - 1];
        if (!generatedImage) {
          const error = `Codex generated ${generatedImages.length}/${count} discoverable image files.`;
          emitLog(`Image ${index} missing: ${error}`, "error");
          results.push(buildGeneration(prompt, "codex", "", "failed", error, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, index, summaryPath));
          continue;
        }

        const outputPath = path.join(outputDir, `${sanitizeFileName(prompt)}-${index}.png`);
        await copyFile(generatedImage, outputPath);
        emitLog(`Saved Codex image ${index}/${count}: ${outputPath}`);
        results.push(buildGeneration(prompt, "codex", outputPath, "completed", "", settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, index, summaryPath));
      }
      resolve(results);
    });
  });
}

async function findGeneratedImages(sessionId: string, startedAt: Date, limit: number): Promise<string[]> {
  const roots = [
    process.env.CODEX_HOME,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, ".codex") : "",
    path.join(app.getPath("home"), ".codex")
  ].filter((candidate): candidate is string => Boolean(candidate));
  const uniqueRoots = Array.from(new Set(roots.map((candidate) => path.resolve(candidate))));
  const candidates: Array<{ filePath: string; mtimeMs: number }> = [];

  for (const root of uniqueRoots) {
    const generatedRoot = path.join(root, "generated_images");
    if (sessionId) {
      await collectGeneratedImages(path.join(generatedRoot, sessionId), candidates, 2);
    } else {
      await collectGeneratedImages(generatedRoot, candidates, 2);
    }
  }

  const startedAtMs = startedAt.getTime() - 5000;
  return candidates
    .filter((candidate) => candidate.mtimeMs >= startedAtMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, limit)
    .map((candidate) => candidate.filePath);
}

async function collectGeneratedImages(
  directory: string,
  candidates: Array<{ filePath: string; mtimeMs: number }>,
  depth: number
): Promise<void> {
  if (depth < 0 || !existsSync(directory)) return;
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await collectGeneratedImages(entryPath, candidates, depth - 1);
      } else if (entry.isFile() && isImagePath(entryPath)) {
        candidates.push({ filePath: entryPath, mtimeMs: statSync(entryPath).mtimeMs });
      }
    }
  } catch {
    // First-run and permission misses are normal here.
  }
}

async function runOpenAiGeneration(
  prompt: string,
  settings: PixelForgeSettings,
  emitLog: (message: string, stream?: "info" | "stdout" | "stderr" | "error") => void
): Promise<ImageGeneration[]> {
  const apiKey = await store.getOpenAiApiKey();
  if (!apiKey) {
    throw new Error("Add an OpenAI API key in Settings or set OPENAI_API_KEY before using the OpenAI provider.");
  }

  const count = Math.max(1, Math.min(10, Math.floor(settings.count)));
  const createdAt = new Date().toISOString();
  const batchId = randomUUID();
  const batchStamp = createdAt.replace(/[:.]/g, "-");
  const outputDir = path.join(settings.outputRoot, "openai", batchStamp);
  const summaryPath = path.join(outputDir, "openai-request.json");
  await mkdir(outputDir, { recursive: true });

  emitLog(`Starting OpenAI Images API batch for ${count} image${count === 1 ? "" : "s"}.`);
  emitLog(`Model: ${settings.openAiModel}`);
  emitLog(`Size: ${settings.openAiSize}`);
  emitLog(`Output: ${outputDir}`);

  const results: ImageGeneration[] = [];
  const requests = settings.openAiModel === "dall-e-3"
    ? Array.from({ length: count }, () => 1)
    : [count];
  let imageIndex = 1;

  await writeFile(summaryPath, JSON.stringify({
    model: settings.openAiModel,
    prompt,
    count,
    size: settings.openAiSize,
    quality: settings.openAiQuality,
    output_format: settings.openAiFormat,
    moderation: settings.openAiModeration,
    createdAt
  }, null, 2), "utf8");

  for (const requestCount of requests) {
    const body = buildOpenAiRequestBody(prompt, settings, requestCount);
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await readOpenAiError(response);
      emitLog(error, "error");
      const remaining = count - results.length;
      results.push(...buildFailedResults(prompt, "openai", remaining, settings.openAiModel, settings.openAiSize, batchId, summaryPath, error, results.length));
      break;
    }

    const payload = await response.json() as {
      data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    };
    const images = payload.data ?? [];
    for (const image of images) {
      const outputPath = path.join(outputDir, `${sanitizeFileName(prompt)}-${imageIndex}.${settings.openAiFormat}`);
      const bytes = image.b64_json
        ? Buffer.from(image.b64_json, "base64")
        : image.url
          ? await downloadImage(image.url)
          : null;
      if (!bytes) {
        const error = "OpenAI returned an image item without base64 data or a URL.";
        emitLog(error, "error");
        results.push(buildGeneration(prompt, "openai", "", "failed", error, settings.openAiModel, settings.openAiSize, batchId, imageIndex, summaryPath));
      } else {
        await writeFile(outputPath, bytes);
        emitLog(`Saved OpenAI image ${imageIndex}/${count}: ${outputPath}`);
        results.push(buildGeneration(prompt, "openai", outputPath, "completed", "", settings.openAiModel, settings.openAiSize, batchId, imageIndex, summaryPath));
      }
      imageIndex++;
    }
  }

  return results.slice(0, count);
}

function buildOpenAiRequestBody(prompt: string, settings: PixelForgeSettings, count: number): Record<string, unknown> {
  const model = settings.openAiModel.trim() || "gpt-image-2";
  if (model.startsWith("dall-e")) {
    return {
      model,
      prompt,
      n: model === "dall-e-3" ? 1 : count,
      size: normalizeDallESize(model, settings.openAiSize),
      quality: model === "dall-e-3" && (settings.openAiQuality === "hd" || settings.openAiQuality === "standard")
        ? settings.openAiQuality
        : "standard",
      response_format: "b64_json"
    };
  }

  return {
    model,
    prompt,
    n: count,
    size: settings.openAiSize || sizeForAspectRatio(settings.aspectRatio),
    quality: ["low", "medium", "high", "auto"].includes(settings.openAiQuality) ? settings.openAiQuality : "auto",
    output_format: settings.openAiFormat,
    moderation: settings.openAiModeration
  };
}

function normalizeDallESize(model: string, size: string): string {
  if (model === "dall-e-2") {
    return ["256x256", "512x512", "1024x1024"].includes(size) ? size : "1024x1024";
  }
  return ["1024x1024", "1792x1024", "1024x1792"].includes(size) ? size : "1024x1024";
}

async function readOpenAiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message || `OpenAI request failed with HTTP ${response.status}.`;
  } catch {
    return `OpenAI request failed with HTTP ${response.status}.`;
  }
}

async function downloadImage(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Image download failed with HTTP ${response.status}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function buildGeneration(
  prompt: string,
  provider: "codex" | "openai",
  outputPath: string,
  status: "completed" | "failed",
  error: string,
  model: string,
  size: string,
  batchId: string,
  index: number,
  summaryPath: string
): ImageGeneration {
  return {
    id: randomUUID(),
    prompt,
    provider,
    outputPath,
    status,
    error,
    createdAt: new Date().toISOString(),
    model,
    size,
    batchId,
    index,
    summaryPath
  };
}

function buildFailedResults(
  prompt: string,
  provider: "codex" | "openai",
  count: number,
  model: string,
  size: string,
  batchId: string,
  summaryPath: string,
  error: string,
  startIndex = 0
): ImageGeneration[] {
  return Array.from({ length: count }, (_value, index) => (
    buildGeneration(prompt, provider, "", "failed", error, model, size, batchId, startIndex + index + 1, summaryPath)
  ));
}

function setUpdateState(patch: Partial<UpdateState>): void {
  updateState = { ...updateState, ...patch, currentVersion: app.getVersion() };
  mainWindow?.webContents.send("update:state", updateState);
}

function initUpdater(): any {
  if (updater) return updater;
  if (!app.isPackaged) return null;
  try {
    ({ autoUpdater: updater } = require("electron-updater"));
  } catch {
    return null;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.on("checking-for-update", () => setUpdateState({ status: "checking", error: null }));
  updater.on("update-available", (info: { version?: string }) =>
    setUpdateState({ status: "downloading", version: info.version ?? null, progress: 0, error: null }));
  updater.on("update-not-available", () =>
    setUpdateState({ status: "uptodate", version: null, progress: 0, error: null }));
  updater.on("download-progress", (progress: { percent?: number }) =>
    setUpdateState({ status: "downloading", progress: Math.round(progress.percent ?? 0) }));
  updater.on("update-downloaded", (info: { version?: string }) => {
    updateReadyVersion = info.version ?? "";
    setUpdateState({ status: "ready", version: updateReadyVersion, progress: 100, error: null });
  });
  updater.on("error", (error: Error) => {
    setUpdateState({ status: "error", error: error.message });
  });
  return updater;
}

function checkForUpdates(): void {
  const activeUpdater = initUpdater();
  if (!activeUpdater) {
    setUpdateState({ status: "dev" });
    return;
  }
  if (updateState.status === "checking" || updateState.status === "downloading" || updateState.status === "ready") return;
  activeUpdater.checkForUpdates().catch((error: Error) => setUpdateState({ status: "error", error: error.message }));
}

function applyAutoUpdateSetting(enabled: boolean): void {
  if (updateStartTimer) clearTimeout(updateStartTimer);
  if (updateIntervalTimer) clearInterval(updateIntervalTimer);
  if (!enabled) return;
  updateStartTimer = setTimeout(checkForUpdates, 15_000);
  updateIntervalTimer = setInterval(checkForUpdates, updateCheckIntervalMs);
}

function registerIpcHandlers(): void {
  ipcMain.handle("state:load", () => store.load());
  ipcMain.handle("settings:update", async (_event, settings: PixelForgeSettings) => {
    const saved = await store.updateSettings(settings);
    applyAutoUpdateSetting(saved.autoUpdate);
    return saved;
  });
  ipcMain.handle("secret:saveOpenAiApiKey", (_event, apiKey: string) => store.saveOpenAiApiKey(apiKey));
  ipcMain.handle("secret:clearOpenAiApiKey", () => store.clearOpenAiApiKey());
  ipcMain.handle("secret:status", () => store.getSecretStatus());

  ipcMain.handle("output:chooseRoot", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose PixelForge output folder",
      properties: ["openDirectory", "createDirectory"]
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle("generation:run", async (event, request: GenerateImagesRequest): Promise<GenerateImagesResult> => {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error("Add a prompt before generating images.");
    const settings = await store.updateSettings(request.settings);
    await mkdir(settings.outputRoot, { recursive: true });
    const emitLog = (message: string, stream: "info" | "stdout" | "stderr" | "error" = "info") =>
      emitGenerationLog(event.sender, message, stream);

    const generations = settings.provider === "openai"
      ? await runOpenAiGeneration(prompt, settings, emitLog)
      : await runCodexGeneration(prompt, settings, emitLog);
    const allGenerations = await store.addGenerations(generations);
    const completed = generations.filter((generation) => generation.status === "completed").length;
    event.sender.send("generation:update", {
      generations: allGenerations,
      message: `Generated ${completed}/${generations.length} image${generations.length === 1 ? "" : "s"}.`
    });
    return { generations };
  });

  ipcMain.handle("generation:delete", async (_event, generationId: string) => {
    const state = await store.load();
    const generation = state.generations.find((candidate) => candidate.id === generationId);
    if (generation?.outputPath) {
      const outputRoot = path.resolve(state.settings.outputRoot);
      const outputPath = path.resolve(generation.outputPath);
      if (outputPath.startsWith(outputRoot + path.sep)) {
        await rm(outputPath, { force: true });
      }
    }
    return store.deleteGeneration(generationId);
  });

  ipcMain.handle("asset:url", async (_event, filePath: string) => {
    if (!existsSync(filePath) || !isImagePath(filePath)) return "";
    const token = tokenForAsset(filePath);
    return `http://127.0.0.1:${assetServerPort}/asset/${token}`;
  });

  ipcMain.handle("shell:openPath", async (_event, filePath: string) => {
    if (filePath) await shell.openPath(filePath);
  });
  ipcMain.handle("shell:showItemInFolder", (_event, filePath: string) => {
    if (filePath && existsSync(filePath)) shell.showItemInFolder(filePath);
  });
  ipcMain.handle("image:copy", async (_event, filePath: string) => {
    if (!filePath || !existsSync(filePath)) return false;
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  });

  ipcMain.handle("update:getState", () => ({
    ...updateState,
    status: !app.isPackaged && updateState.status === "idle" ? "dev" : updateState.status,
    currentVersion: app.getVersion()
  }));
  ipcMain.on("update:check", () => checkForUpdates());
  ipcMain.on("update:install", () => {
    if (updateReadyVersion && updater) {
      updater.quitAndInstall();
    }
  });
  ipcMain.on("releases:open", () => shell.openExternal(releaseUrl));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId("no.cwb.pixelforge");
    registerIpcHandlers();
    await startAssetServer();
    await createWindow();
    const state = await store.load();
    applyAutoUpdateSetting(state.settings.autoUpdate);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });

  app.on("before-quit", () => {
    assetServer?.close();
    if (updateStartTimer) clearTimeout(updateStartTimer);
    if (updateIntervalTimer) clearInterval(updateIntervalTimer);
  });
}
