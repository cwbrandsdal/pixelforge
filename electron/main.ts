import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from "electron";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  canPrepareOpenAiImageReference,
  isGeneratedImagePath,
  isOpenAiRasterReferenceFile,
  isPreviewableReferenceFile,
  isSupportedReferenceFile,
  isSvgReferenceFile,
  isTextReferenceFile,
  mimeTypeForReferenceFile,
  referenceFileTypeLabel
} from "./reference-files.js";
import { PixlForgeStore } from "./store.js";
import type {
  GenerateImagesRequest,
  GenerateImagesResult,
  GenerationKind,
  GenerationProvider,
  ImageGeneration,
  PixlForgeProject,
  PixlForgeSettings,
  ReferenceFile,
  UpscaleImagesRequest,
  UpscaleImagesResult,
  UpdateState
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isDev = !app.isPackaged;
const devRendererPort = Number(process.env.PIXLFORGE_DEV_RENDERER_PORT || "17851");
const releaseUrl = "https://github.com/cwbrandsdal/pixlforge/releases";
const updateCheckIntervalMs = 4 * 60 * 60 * 1000;

const store = new PixlForgeStore();
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

type OpenAiReferenceImage = { image_url: string };

const openAiReferenceImageLimitBytes = 20 * 1024 * 1024;
const referenceTextFileLimitBytes = 2 * 1024 * 1024;
const referenceTextSnippetLimit = 4000;
const referenceTextTotalLimit = 12000;

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 940,
    minWidth: 1060,
    minHeight: 720,
    title: "PixlForge",
    backgroundColor: "#07192c",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../assets/icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#07192c",
      symbolColor: "#eaf5f7",
      height: 36
    },
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
    if (!filePath || !existsSync(filePath) || !isPreviewableReferenceFile(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": mimeTypeForReferenceFile(filePath),
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
    .slice(0, 80) || "pixlforge";
}

function normalizeCodexReasoningEffort(value: PixlForgeSettings["codexReasoningEffort"]): PixlForgeSettings["codexReasoningEffort"] {
  return value === "medium" || value === "high" || value === "xhigh" ? value : "low";
}

function sizeForAspectRatio(aspectRatio: PixlForgeSettings["aspectRatio"]): string {
  if (aspectRatio === "16:9") return "1536x864";
  if (aspectRatio === "9:16") return "864x1536";
  if (aspectRatio === "4:3") return "1536x1152";
  if (aspectRatio === "3:4") return "1152x1536";
  return "1024x1024";
}

function buildCodexImagePrompt(prompt: string, settings: PixlForgeSettings, referenceFiles: ReferenceFile[], referenceTextContext: string): string {
  const count = Math.max(1, Math.min(10, Math.floor(settings.count)));
  const variants = Array.from({ length: count }, (_value, index) => {
    const variant = index + 1;
    return `Variant ${variant}: Change composition, crop, lighting, color balance, foreground/background hierarchy, and focal emphasis while preserving the user's subject and constraints.`;
  }).join("\n");
  const references = referenceFiles.length
    ? referenceFiles.map((file, index) => `${index + 1}. ${file.name} (${referenceFileTypeLabel(file)}; ${file.mimeType}; source path ${file.path})`).join("\n")
    : "No reference files were attached.";

  return [
    "$imagegen",
    "",
    `Generate ${count} separate PixlForge image${count === 1 ? "" : "s"} from this prompt.`,
    "",
    "Important execution rule: make one separate built-in image generation call per variant. Do not use one image as the answer for multiple variants.",
    `Target aspect ratio: ${settings.aspectRatio}.`,
    `Suggested pixel size: ${sizeForAspectRatio(settings.aspectRatio)}.`,
    "",
    "User prompt:",
    prompt.trim(),
    "",
    "Reference files:",
    references,
    referenceFiles.length
      ? "Use attached/reference file details for logos, brand details, products, art direction, document constraints, or source material when the prompt asks for them."
      : "",
    referenceTextContext ? "\nReference document excerpts:\n" + referenceTextContext : "",
    "",
    "Variant directions:",
    variants,
    "",
    "Requirements:",
    "- Preserve explicit subject, style, text, brand, and composition constraints from the user prompt.",
    "- Make each variant meaningfully different, not a minor recolor or tiny crop change.",
    "- Avoid watermarks, UI chrome, unreadable text, and unrelated visual elements.",
    "- Generate only the requested images using the built-in image generation tool.",
    "- Do not search the filesystem. If a non-image reference must be read, read only the listed reference file path.",
    "- Do not inspect CODEX_HOME or generated_images.",
    "- Do not copy, move, rename, inspect, or save files manually. PixlForge will collect the generated images after this run.",
    "- After all images are generated, reply with only: GENERATED"
  ].join("\n");
}

async function runCodexGeneration(
  prompt: string,
  settings: PixlForgeSettings,
  project: PixlForgeProject,
  referenceFiles: ReferenceFile[],
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
  const outputDir = path.join(project.outputDir, "generations", "codex", batchStamp);
  const summaryPath = path.join(outputDir, "codex-summary.md");
  const jobStartedAt = new Date();
  await mkdir(outputDir, { recursive: true });
  const referenceTextContext = await buildReferenceTextContext(referenceFiles);
  const imageReferenceFiles = await prepareCodexImageReferenceFiles(referenceFiles, outputDir, emitLog);

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
  for (const referenceFile of imageReferenceFiles) {
    if (existsSync(referenceFile.path)) {
      args.push("--image", referenceFile.path);
    }
  }
  args.push("-");

  emitLog(`Starting Codex batch for ${count} image${count === 1 ? "" : "s"}.`);
  emitLog(`Project: ${project.name}`);
  emitLog(`Codex CLI: ${codexPath}`);
  emitLog(`Output: ${outputDir}`);
  emitLog(`Reasoning effort: ${normalizeCodexReasoningEffort(settings.codexReasoningEffort)}.`);
  if (imageReferenceFiles.length) {
    emitLog(`Attached ${imageReferenceFiles.length} image reference${imageReferenceFiles.length === 1 ? "" : "s"}.`);
  }
  const promptOnlyReferences = referenceFiles.length - imageReferenceFiles.length;
  if (promptOnlyReferences > 0) {
    emitLog(`Included ${promptOnlyReferences} prompt-only reference file${promptOnlyReferences === 1 ? "" : "s"} in the prompt context.`);
  }

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
      resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, message, project.id, referenceFiles));
      return;
    }

    child.stdin?.end(buildCodexImagePrompt(prompt, settings, referenceFiles, referenceTextContext));
    child.stdout?.on("data", (chunk: Buffer) => handleChunk("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => handleChunk("stderr", chunk));
    child.on("error", (error) => {
      emitLog(`Codex failed to start: ${error.message}`, "error");
      resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, error.message, project.id, referenceFiles));
    });
    child.on("close", async (code) => {
      flushLine("stdout", stdoutRemainder);
      flushLine("stderr", stderrRemainder);
      if (code !== 0) {
        const error = lastError || `Codex exited with code ${code ?? "unknown"}.`;
        emitLog(error, "error");
        resolve(buildFailedResults(prompt, "codex", count, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, summaryPath, error, project.id, referenceFiles));
        return;
      }

      const generatedImages = await findGeneratedImages(sessionId, jobStartedAt, count);
      const results: ImageGeneration[] = [];
      for (let index = 1; index <= count; index++) {
        const generatedImage = generatedImages[index - 1];
        if (!generatedImage) {
          const error = `Codex generated ${generatedImages.length}/${count} discoverable image files.`;
          emitLog(`Image ${index} missing: ${error}`, "error");
          results.push(buildGeneration(prompt, "codex", "", "failed", error, settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, index, summaryPath, project.id, referenceFiles));
          continue;
        }

        const outputPath = path.join(outputDir, `${sanitizeFileName(prompt)}-${index}.png`);
        await copyFile(generatedImage, outputPath);
        emitLog(`Saved Codex image ${index}/${count}: ${outputPath}`);
        results.push(buildGeneration(prompt, "codex", outputPath, "completed", "", settings.codexModel || "codex", sizeForAspectRatio(settings.aspectRatio), batchId, index, summaryPath, project.id, referenceFiles));
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
      } else if (entry.isFile() && isGeneratedImagePath(entryPath)) {
        candidates.push({ filePath: entryPath, mtimeMs: statSync(entryPath).mtimeMs });
      }
    }
  } catch {
    // First-run and permission misses are normal here.
  }
}

async function runOpenAiGeneration(
  prompt: string,
  settings: PixlForgeSettings,
  project: PixlForgeProject,
  referenceFiles: ReferenceFile[],
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
  const outputDir = path.join(project.outputDir, "generations", "openai", batchStamp);
  const summaryPath = path.join(outputDir, "openai-request.json");
  await mkdir(outputDir, { recursive: true });
  const promptWithReferenceContext = await appendReferenceTextContext(prompt, referenceFiles);
  const model = settings.openAiModel.trim() || "gpt-image-2";
  const supportsImageReferences = !model.startsWith("dall-e");
  const imageReferenceFiles = supportsImageReferences
    ? referenceFiles.filter(canPrepareOpenAiImageReference).slice(0, 16)
    : [];
  const openAiReferenceImages = imageReferenceFiles.length
    ? await prepareOpenAiReferenceImages(imageReferenceFiles, emitLog)
    : [];
  const unsupportedReferenceCount = referenceFiles.length - openAiReferenceImages.length;

  emitLog(`Starting OpenAI Images API batch for ${count} image${count === 1 ? "" : "s"}.`);
  emitLog(`Project: ${project.name}`);
  emitLog(`Model: ${settings.openAiModel}`);
  emitLog(`Size: ${settings.openAiSize}`);
  emitLog(`Output: ${outputDir}`);
  if (openAiReferenceImages.length) {
    emitLog(`Using ${openAiReferenceImages.length} image reference${openAiReferenceImages.length === 1 ? "" : "s"} through the image edits endpoint.`);
  }
  if (referenceFiles.length && !supportsImageReferences) {
    emitLog("DALL-E models do not support PixlForge image reference attachments; supported text excerpts are appended to the prompt.");
  }
  if (unsupportedReferenceCount > 0) {
    emitLog(`Stored ${unsupportedReferenceCount} reference file${unsupportedReferenceCount === 1 ? "" : "s"} that OpenAI Images cannot receive directly; supported text excerpts are appended to the prompt.`);
  }

  const results: ImageGeneration[] = [];
  const requests = settings.openAiModel === "dall-e-3"
    ? Array.from({ length: count }, () => 1)
    : [count];
  let imageIndex = 1;

  await writeFile(summaryPath, JSON.stringify({
    model: settings.openAiModel,
    prompt: promptWithReferenceContext,
    count,
    size: settings.openAiSize,
    quality: settings.openAiQuality,
    output_format: settings.openAiFormat,
    moderation: settings.openAiModeration,
    referenceFiles: referenceFiles.map((file) => ({ name: file.name, path: file.path, mimeType: file.mimeType })),
    imageReferenceFiles: imageReferenceFiles.map((file) => ({ name: file.name, path: file.path, mimeType: file.mimeType })),
    sentImageReferences: openAiReferenceImages.length,
    createdAt
  }, null, 2), "utf8");

  for (const requestCount of requests) {
    const endpoint = openAiReferenceImages.length
      ? "https://api.openai.com/v1/images/edits"
      : "https://api.openai.com/v1/images/generations";
    const body = openAiReferenceImages.length
      ? buildOpenAiEditRequestBody(promptWithReferenceContext, settings, requestCount, openAiReferenceImages)
      : buildOpenAiRequestBody(promptWithReferenceContext, settings, requestCount);
    const response = await fetch(endpoint, {
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
      results.push(...buildFailedResults(prompt, "openai", remaining, settings.openAiModel, settings.openAiSize, batchId, summaryPath, error, project.id, referenceFiles, results.length));
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
        results.push(buildGeneration(prompt, "openai", "", "failed", error, settings.openAiModel, settings.openAiSize, batchId, imageIndex, summaryPath, project.id, referenceFiles));
      } else {
        await writeFile(outputPath, bytes);
        emitLog(`Saved OpenAI image ${imageIndex}/${count}: ${outputPath}`);
        results.push(buildGeneration(prompt, "openai", outputPath, "completed", "", settings.openAiModel, settings.openAiSize, batchId, imageIndex, summaryPath, project.id, referenceFiles));
      }
      imageIndex++;
    }
  }

  return results.slice(0, count);
}

function buildOpenAiRequestBody(prompt: string, settings: PixlForgeSettings, count: number): Record<string, unknown> {
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

function buildOpenAiEditRequestBody(
  prompt: string,
  settings: PixlForgeSettings,
  count: number,
  images: OpenAiReferenceImage[]
): Record<string, unknown> {
  const model = settings.openAiModel.trim() || "gpt-image-2";
  if (model.startsWith("dall-e")) {
    throw new Error("OpenAI reference images require a GPT Image model such as gpt-image-2.");
  }

  if (!images.length) {
    throw new Error("No supported reference images were available for the OpenAI request.");
  }

  return {
    model,
    prompt,
    images,
    n: count,
    size: settings.openAiSize || sizeForAspectRatio(settings.aspectRatio),
    quality: ["low", "medium", "high", "auto"].includes(settings.openAiQuality) ? settings.openAiQuality : "auto",
    output_format: settings.openAiFormat,
    moderation: settings.openAiModeration,
    input_fidelity: "high"
  };
}

async function prepareCodexImageReferenceFiles(
  referenceFiles: ReferenceFile[],
  outputDir: string,
  emitLog: (message: string, stream?: "info" | "stdout" | "stderr" | "error") => void
): Promise<ReferenceFile[]> {
  const prepared: ReferenceFile[] = [];
  const preparedDir = path.join(outputDir, "prepared-references");
  for (const referenceFile of referenceFiles) {
    if (!existsSync(referenceFile.path)) continue;
    if (isOpenAiRasterReferenceFile(referenceFile)) {
      prepared.push(referenceFile);
      continue;
    }
    if (!isSvgReferenceFile(referenceFile.path)) continue;
    try {
      await mkdir(preparedDir, { recursive: true });
      const targetPath = path.join(preparedDir, `${sanitizeFileName(path.basename(referenceFile.name, path.extname(referenceFile.name)))}-${referenceFile.id.slice(0, 8)}.png`);
      await sharp(referenceFile.path, { density: 192 })
        .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(targetPath);
      const targetSize = statSync(targetPath).size;
      prepared.push({
        ...referenceFile,
        path: targetPath,
        mimeType: "image/png",
        size: targetSize
      });
      emitLog(`Prepared SVG reference for image attachment: ${referenceFile.name}`);
    } catch (error) {
      emitLog(`Could not prepare SVG reference ${referenceFile.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  return prepared;
}

async function prepareOpenAiReferenceImages(
  referenceFiles: ReferenceFile[],
  emitLog: (message: string, stream?: "info" | "stdout" | "stderr" | "error") => void
): Promise<OpenAiReferenceImage[]> {
  const images: OpenAiReferenceImage[] = [];
  for (const referenceFile of referenceFiles) {
    try {
      const imageUrl = await buildOpenAiReferenceImageUrl(referenceFile);
      if (!imageUrl) {
        emitLog(`Skipped OpenAI image reference ${referenceFile.name}; it is too large or could not be prepared.`);
        continue;
      }
      images.push({ image_url: imageUrl });
    } catch (error) {
      emitLog(`Could not prepare OpenAI image reference ${referenceFile.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }
  return images;
}

async function buildOpenAiReferenceImageUrl(referenceFile: ReferenceFile): Promise<string | null> {
  if (!existsSync(referenceFile.path)) return null;
  if (isOpenAiRasterReferenceFile(referenceFile)) {
    if (referenceFile.size > openAiReferenceImageLimitBytes) return null;
    const bytes = await readFile(referenceFile.path);
    return `data:${referenceFile.mimeType};base64,${bytes.toString("base64")}`;
  }
  if (!isSvgReferenceFile(referenceFile.path)) return null;
  const bytes = await sharp(referenceFile.path, { density: 192 })
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  if (bytes.length > openAiReferenceImageLimitBytes) return null;
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function appendReferenceTextContext(prompt: string, referenceFiles: ReferenceFile[]): Promise<string> {
  const context = await buildReferenceTextContext(referenceFiles);
  if (!context) return prompt;
  return [
    prompt.trim(),
    "",
    "Reference document excerpts:",
    context
  ].join("\n");
}

async function buildReferenceTextContext(referenceFiles: ReferenceFile[]): Promise<string> {
  const snippets: string[] = [];
  let remaining = referenceTextTotalLimit;
  for (const referenceFile of referenceFiles) {
    if (remaining <= 0) break;
    if (!existsSync(referenceFile.path) || (!isTextReferenceFile(referenceFile.path) && !isSvgReferenceFile(referenceFile.path))) continue;
    if (referenceFile.size > referenceTextFileLimitBytes) continue;
    try {
      const content = (await readFile(referenceFile.path, "utf8")).replace(/\u0000/g, "").trim();
      if (!content) continue;
      const limit = Math.min(referenceTextSnippetLimit, remaining);
      const excerpt = content.length > limit ? `${content.slice(0, limit)}\n[truncated]` : content;
      snippets.push(`${referenceFile.name} (${referenceFileTypeLabel(referenceFile)}):\n${excerpt}`);
      remaining -= excerpt.length;
    } catch {
      // Binary or unreadable reference files can still be stored and listed.
    }
  }
  return snippets.join("\n\n");
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

async function runLocalUpscale(
  sourceGenerations: ImageGeneration[],
  project: PixlForgeProject,
  emitLog: (message: string, stream?: "info" | "stdout" | "stderr" | "error") => void
): Promise<ImageGeneration[]> {
  const candidates = sourceGenerations.filter((generation) =>
    generation.status === "completed" &&
    generation.outputPath &&
    existsSync(generation.outputPath) &&
    isGeneratedImagePath(generation.outputPath)
  );
  if (!candidates.length) {
    throw new Error("Select at least one completed image to upscale.");
  }

  const createdAt = new Date().toISOString();
  const batchId = randomUUID();
  const batchStamp = createdAt.replace(/[:.]/g, "-");
  const outputDir = path.join(project.outputDir, "generations", "upscaled", batchStamp);
  const summaryPath = path.join(outputDir, "upscale-summary.json");
  await mkdir(outputDir, { recursive: true });

  emitLog(`Starting local 4K upscale for ${candidates.length} image${candidates.length === 1 ? "" : "s"}.`);
  emitLog(`Project: ${project.name}`);
  emitLog(`Output: ${outputDir}`);

  const results: ImageGeneration[] = [];
  const summary: Array<Record<string, unknown>> = [];
  for (let index = 0; index < candidates.length; index++) {
    const source = candidates[index];
    try {
      const metadata = await sharp(source.outputPath).metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (!width || !height) {
        throw new Error("Could not read source image dimensions.");
      }

      const target = get4kTargetDimensions(width, height);
      const fileName = `${sanitizeFileName(path.basename(source.outputPath, path.extname(source.outputPath)))}-4k.png`;
      const outputPath = path.join(outputDir, uniqueFileName(fileName, index + 1));

      await sharp(source.outputPath)
        .rotate()
        .resize({
          width: target.width,
          height: target.height,
          fit: "fill",
          kernel: sharp.kernel.lanczos3,
          withoutEnlargement: false
        })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(outputPath);

      emitLog(`Upscaled ${index + 1}/${candidates.length}: ${target.width}x${target.height} ${outputPath}`);
      summary.push({
        sourceId: source.id,
        sourcePath: source.outputPath,
        outputPath,
        sourceSize: `${width}x${height}`,
        outputSize: `${target.width}x${target.height}`
      });
      results.push(buildGeneration(
        source.prompt,
        "local",
        outputPath,
        "completed",
        "",
        "PixlForge local upscaler",
        `${target.width}x${target.height}`,
        batchId,
        index + 1,
        summaryPath,
        project.id,
        [],
        "final",
        source.id
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitLog(`Upscale failed for ${source.outputPath}: ${message}`, "error");
      summary.push({
        sourceId: source.id,
        sourcePath: source.outputPath,
        error: message
      });
      results.push(buildGeneration(
        source.prompt,
        "local",
        "",
        "failed",
        message,
        "PixlForge local upscaler",
        "4K",
        batchId,
        index + 1,
        summaryPath,
        project.id,
        [],
        "final",
        source.id
      ));
    }
  }

  await writeFile(summaryPath, JSON.stringify({
    createdAt,
    projectId: project.id,
    target: "4K",
    images: summary
  }, null, 2), "utf8");

  return results;
}

function get4kTargetDimensions(width: number, height: number): { width: number; height: number } {
  const targetLongEdge = width === height ? 4096 : 3840;
  const scale = Math.max(1, targetLongEdge / Math.max(width, height));
  return {
    width: makeEven(Math.round(width * scale)),
    height: makeEven(Math.round(height * scale))
  };
}

function makeEven(value: number): number {
  return Math.max(2, value % 2 === 0 ? value : value + 1);
}

function uniqueFileName(fileName: string, index: number): string {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  return `${baseName}-${index}${extension}`;
}

function buildGeneration(
  prompt: string,
  provider: GenerationProvider,
  outputPath: string,
  status: "completed" | "failed",
  error: string,
  model: string,
  size: string,
  batchId: string,
  index: number,
  summaryPath: string,
  projectId: string,
  referenceFiles: ReferenceFile[],
  kind: GenerationKind = "draft",
  parentGenerationId = ""
): ImageGeneration {
  return {
    id: randomUUID(),
    projectId,
    prompt,
    provider,
    kind,
    parentGenerationId,
    outputPath,
    status,
    error,
    createdAt: new Date().toISOString(),
    model,
    size,
    batchId,
    index,
    summaryPath,
    referenceFilePaths: referenceFiles.map((file) => file.path)
  };
}

function buildFailedResults(
  prompt: string,
  provider: GenerationProvider,
  count: number,
  model: string,
  size: string,
  batchId: string,
  summaryPath: string,
  error: string,
  projectId: string,
  referenceFiles: ReferenceFile[],
  startIndex = 0,
  kind: GenerationKind = "draft",
  parentGenerationId = ""
): ImageGeneration[] {
  return Array.from({ length: count }, (_value, index) => (
    buildGeneration(prompt, provider, "", "failed", error, model, size, batchId, startIndex + index + 1, summaryPath, projectId, referenceFiles, kind, parentGenerationId)
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
  ipcMain.handle("settings:update", async (_event, settings: PixlForgeSettings) => {
    const saved = await store.updateSettings(settings);
    applyAutoUpdateSetting(saved.autoUpdate);
    return saved;
  });
  ipcMain.handle("project:create", (_event, name: string) => store.createProject(name));
  ipcMain.handle("project:update", (_event, project: PixlForgeProject) => store.updateProject(project));
  ipcMain.handle("project:delete", (_event, projectId: string) => store.deleteProject(projectId));
  ipcMain.handle("project:setActive", (_event, projectId: string) => store.setActiveProject(projectId));
  ipcMain.handle("project:addReferenceFiles", async (event, projectId: string) => {
    const options: Electron.OpenDialogOptions = {
      title: "Add reference files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Reference files",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "webp",
            "gif",
            "svg",
            "pdf",
            "txt",
            "md",
            "markdown",
            "csv",
            "tsv",
            "json",
            "jsonl",
            "html",
            "htm",
            "css",
            "xml",
            "yaml",
            "yml",
            "rtf",
            "doc",
            "docx",
            "ppt",
            "pptx",
            "xls",
            "xlsx",
            "ai",
            "eps",
            "psd",
            "fig",
            "sketch"
          ]
        }
      ]
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) {
      const state = await store.load();
      const project = state.projects.find((candidate) => candidate.id === projectId);
      if (!project) throw new Error("Project not found.");
      return project;
    }
    const supportedFiles = result.filePaths.filter(isSupportedReferenceFile);
    return store.addReferenceFiles(projectId, supportedFiles);
  });
  ipcMain.handle("project:removeReferenceFile", (_event, projectId: string, referenceId: string) =>
    store.removeReferenceFile(projectId, referenceId));
  ipcMain.handle("secret:saveOpenAiApiKey", (_event, apiKey: string) => store.saveOpenAiApiKey(apiKey));
  ipcMain.handle("secret:clearOpenAiApiKey", () => store.clearOpenAiApiKey());
  ipcMain.handle("secret:status", () => store.getSecretStatus());

  ipcMain.handle("output:chooseRoot", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose PixlForge output folder",
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
    const state = await store.setActiveProject(request.projectId);
    const project = state.projects.find((candidate) => candidate.id === request.projectId);
    if (!project) throw new Error("Project not found.");
    await mkdir(project.outputDir, { recursive: true });
    const emitLog = (message: string, stream: "info" | "stdout" | "stderr" | "error" = "info") =>
      emitGenerationLog(event.sender, message, stream);

    const generations = settings.provider === "openai"
      ? await runOpenAiGeneration(prompt, settings, project, project.referenceFiles, emitLog)
      : await runCodexGeneration(prompt, settings, project, project.referenceFiles, emitLog);
    const allGenerations = await store.addGenerations(generations);
    const completed = generations.filter((generation) => generation.status === "completed").length;
    event.sender.send("generation:update", {
      generations: allGenerations,
      message: `Created ${completed}/${generations.length} draft${generations.length === 1 ? "" : "s"}.`
    });
    return { generations };
  });

  ipcMain.handle("generation:upscale", async (event, request: UpscaleImagesRequest): Promise<UpscaleImagesResult> => {
    const state = await store.setActiveProject(request.projectId);
    const project = state.projects.find((candidate) => candidate.id === request.projectId);
    if (!project) throw new Error("Project not found.");
    const selectedIds = new Set(request.generationIds);
    const sourceGenerations = state.generations.filter((generation) =>
      selectedIds.has(generation.id) &&
      generation.projectId === request.projectId &&
      generation.kind !== "final"
    );
    const emitLog = (message: string, stream: "info" | "stdout" | "stderr" | "error" = "info") =>
      emitGenerationLog(event.sender, message, stream);

    const generations = await runLocalUpscale(sourceGenerations, project, emitLog);
    const allGenerations = await store.addGenerations(generations);
    const completed = generations.filter((generation) => generation.status === "completed").length;
    event.sender.send("generation:update", {
      generations: allGenerations,
      message: `Created ${completed}/${generations.length} 4K final${generations.length === 1 ? "" : "s"}.`
    });
    return { generations };
  });

  ipcMain.handle("generation:delete", async (_event, generationId: string) => {
    const state = await store.load();
    const generation = state.generations.find((candidate) => candidate.id === generationId);
    if (generation?.outputPath) {
      const project = state.projects.find((candidate) => candidate.id === generation.projectId);
      const allowedRoots = [state.settings.outputRoot, project?.outputDir]
        .filter((candidate): candidate is string => Boolean(candidate))
        .map((candidate) => path.resolve(candidate));
      const outputPath = path.resolve(generation.outputPath);
      if (allowedRoots.some((root) => outputPath.startsWith(root + path.sep))) {
        await rm(outputPath, { force: true });
      }
    }
    return store.deleteGeneration(generationId);
  });

  ipcMain.handle("asset:url", async (_event, filePath: string) => {
    if (!existsSync(filePath) || !isPreviewableReferenceFile(filePath)) return "";
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
    app.setAppUserModelId("no.cwb.pixlforge");
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
