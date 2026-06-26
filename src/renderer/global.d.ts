import type {
  GenerateImagesRequest,
  GenerateImagesResult,
  ImageGeneration,
  PixlForgeProject,
  PixlForgeSettings,
  PixlForgeState,
  SecretStatus,
  UpscaleImagesRequest,
  UpscaleImagesResult,
  UpdateState
} from "../shared/types";

export {};

declare global {
  interface Window {
    pixlforge: {
      loadState: () => Promise<PixlForgeState>;
      updateSettings: (settings: PixlForgeSettings) => Promise<PixlForgeSettings>;
      createProject: (name: string) => Promise<PixlForgeState>;
      updateProject: (project: PixlForgeProject) => Promise<PixlForgeProject>;
      deleteProject: (projectId: string) => Promise<PixlForgeState>;
      setActiveProject: (projectId: string) => Promise<PixlForgeState>;
      addProjectReferenceFiles: (projectId: string) => Promise<PixlForgeProject>;
      removeProjectReferenceFile: (projectId: string, referenceId: string) => Promise<PixlForgeProject>;
      chooseOutputRoot: () => Promise<string | null>;
      generateImages: (request: GenerateImagesRequest) => Promise<GenerateImagesResult>;
      upscaleImages: (request: UpscaleImagesRequest) => Promise<UpscaleImagesResult>;
      deleteGeneration: (generationId: string) => Promise<string>;
      getAssetUrl: (filePath: string) => Promise<string>;
      openPath: (filePath: string) => Promise<void>;
      showItemInFolder: (filePath: string) => Promise<void>;
      copyImage: (filePath: string) => Promise<boolean>;
      saveOpenAiApiKey: (apiKey: string) => Promise<SecretStatus>;
      clearOpenAiApiKey: () => Promise<SecretStatus>;
      getSecretStatus: () => Promise<SecretStatus>;
      getUpdateState: () => Promise<UpdateState>;
      checkForUpdates: () => void;
      installUpdate: () => void;
      openReleasesPage: () => void;
      onGenerationLog: (callback: (payload: { timestamp: string; message: string; stream: "info" | "stdout" | "stderr" | "error" }) => void) => () => void;
      onGenerationUpdate: (callback: (payload: { generations: ImageGeneration[]; message: string }) => void) => () => void;
      onUpdateState: (callback: (state: UpdateState) => void) => () => void;
    };
  }
}
