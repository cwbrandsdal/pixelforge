import { contextBridge, ipcRenderer } from "electron";
import type { GenerateImagesRequest, PixlForgeProject, PixlForgeSettings, UpscaleImagesRequest } from "./types";

const api = {
  loadState: () => ipcRenderer.invoke("state:load"),
  updateSettings: (settings: PixlForgeSettings) => ipcRenderer.invoke("settings:update", settings),
  createProject: (name: string) => ipcRenderer.invoke("project:create", name),
  updateProject: (project: PixlForgeProject) => ipcRenderer.invoke("project:update", project),
  deleteProject: (projectId: string) => ipcRenderer.invoke("project:delete", projectId),
  setActiveProject: (projectId: string) => ipcRenderer.invoke("project:setActive", projectId),
  addProjectReferenceFiles: (projectId: string) => ipcRenderer.invoke("project:addReferenceFiles", projectId),
  removeProjectReferenceFile: (projectId: string, referenceId: string) =>
    ipcRenderer.invoke("project:removeReferenceFile", projectId, referenceId),
  chooseOutputRoot: () => ipcRenderer.invoke("output:chooseRoot"),
  generateImages: (request: GenerateImagesRequest) => ipcRenderer.invoke("generation:run", request),
  upscaleImages: (request: UpscaleImagesRequest) => ipcRenderer.invoke("generation:upscale", request),
  deleteGeneration: (generationId: string) => ipcRenderer.invoke("generation:delete", generationId),
  getAssetUrl: (filePath: string) => ipcRenderer.invoke("asset:url", filePath),
  openPath: (filePath: string) => ipcRenderer.invoke("shell:openPath", filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:showItemInFolder", filePath),
  copyImage: (filePath: string) => ipcRenderer.invoke("image:copy", filePath),
  saveOpenAiApiKey: (apiKey: string) => ipcRenderer.invoke("secret:saveOpenAiApiKey", apiKey),
  clearOpenAiApiKey: () => ipcRenderer.invoke("secret:clearOpenAiApiKey"),
  getSecretStatus: () => ipcRenderer.invoke("secret:status"),
  getUpdateState: () => ipcRenderer.invoke("update:getState"),
  checkForUpdates: () => ipcRenderer.send("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  openReleasesPage: () => ipcRenderer.send("releases:open"),
  onGenerationLog: (callback: (payload: { timestamp: string; message: string; stream: "info" | "stdout" | "stderr" | "error" }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { timestamp: string; message: string; stream: "info" | "stdout" | "stderr" | "error" }) => callback(payload);
    ipcRenderer.on("generation:log", listener);
    return () => ipcRenderer.removeListener("generation:log", listener);
  },
  onGenerationUpdate: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("generation:update", listener);
    return () => ipcRenderer.removeListener("generation:update", listener);
  },
  onUpdateState: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("update:state", listener);
    return () => ipcRenderer.removeListener("update:state", listener);
  }
};

contextBridge.exposeInMainWorld("pixlforge", api);
