# PixlForge

![PixlForge hero](assets/readme-hero.png)

PixlForge is a Windows desktop app for generating image batches from a prompt.

Projects keep separate output folders, generated images, and reference files for workflows like marketing, product art, brand kits, or client work.

The core workflow is draft-first: create several prompt drafts, select the strongest image or images, then upscale those selections into 4K final files inside the same project.

Generation backends:

- Codex CLI with `$imagegen`, using the same generated-image collection pattern as Creator.
- OpenAI Images API with a locally saved API key.
- Project reference files such as logos, screenshots, SVG assets, product photos, text notes, or brand documents can be attached to the prompt.
- Local 4K upscaling for selected draft images, with final files linked back to their source draft.

Secrets are never stored in this repository. The OpenAI API key is stored in the app's per-user Electron data folder using `safeStorage` when available, or can be supplied at runtime with `OPENAI_API_KEY`.

## Development

```powershell
npm install
npm run gen-icon
npm run dev
```

## Build

```powershell
npm run typecheck
npm run dist
```

## Release Flow

Pushes to `main` run the Windows production build in GitHub Actions. If `package.json` contains a version that has not already been released, the workflow creates `vX.Y.Z`, builds the installer, uploads update metadata, and publishes a GitHub Release for the in-app updater.
