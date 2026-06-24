# PixelForge

![PixelForge hero](assets/readme-hero.png)

PixelForge is a Windows desktop app for generating image batches from a prompt.

Generation backends:

- Codex CLI with `$imagegen`, using the same generated-image collection pattern as Creator.
- OpenAI Images API with a locally saved API key.

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
