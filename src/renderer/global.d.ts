import type {
  GenerateImagesRequest,
  GenerateImagesResult,
  ImageGeneration,
  PixelForgeSettings,
  PixelForgeState,
  SecretStatus,
  UpdateState
} from "../shared/types";

export {};

declare global {
  interface Window {
    pixelforge: {
      loadState: () => Promise<PixelForgeState>;
      updateSettings: (settings: PixelForgeSettings) => Promise<PixelForgeSettings>;
      chooseOutputRoot: () => Promise<string | null>;
      generateImages: (request: GenerateImagesRequest) => Promise<GenerateImagesResult>;
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
