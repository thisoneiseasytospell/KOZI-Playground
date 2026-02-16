# 010 Totems

Interactive Three.js installation that presents a set of compressed Rotterdam totems. The repo contains the production-ready static site that you can host anywhere GitHub Pages–style.

## Project structure

- `index.html` – bootstrap markup that wires up the Three.js scene and UI overlays.
- `styles.css` – monospace typography and overlay styling.
- `scripts/` – ES modules that load GLB assets (`main.js`) and helper scripts used while authoring (`build-manifest.mjs`, `main-old.js`).
- `models.json` – manifest describing each GLB (path, title, rotation speed, etc.).
- `objs/` – Draco-compressed GLB files referenced by the manifest.
- `fonts/` – bundled WTSkrappa trial font used for UI typography.

## Running locally

Because `models.json` and the GLB files are fetched through `fetch`, you must serve the project over HTTP instead of double-clicking `index.html`.

```bash
# from the repo root
python3 -m http.server 5173
# or
npx serve .
```

Then open `http://localhost:5173` in a modern browser (Chrome, Edge, Safari 17+, Firefox 120+).

## Deploying / publishing

1. Commit everything in this folder (`git init && git add -A && git commit -m "Initial commit"`).
2. Point the repo at GitHub: `git remote add origin https://github.com/thisoneiseasytospell/010.git`.
3. Replace the remote's contents: `git push --force origin main`.

That `git push --force` wipes whatever is currently on GitHub and uploads these local files, which is exactly what you asked for.
