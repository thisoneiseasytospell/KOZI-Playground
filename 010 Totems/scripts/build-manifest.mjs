import { promises as fs, watch } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const objsDir = path.join(projectRoot, 'objs');

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function shouldIgnoreChange(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  if (lower.endsWith('models.json') || lower.endsWith('manifest.json')) {
    return true;
  }
  return filename
    .split(path.sep)
    .some((segment) => segment.startsWith('.'));
}

function deriveId(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'model';
}

function deriveTitle(name) {
  const cleaned = name
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

async function readJsonIfExists(candidatePaths) {
  for (const filePath of candidatePaths) {
    try {
      const contents = await fs.readFile(filePath, 'utf8');
      return JSON.parse(contents);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[manifest] Failed to read ${filePath}:`, error.message);
      }
    }
  }
  return null;
}

async function collectDirectoryModel(dirent) {
  const dirPath = path.join(objsDir, dirent.name);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());

  const glb = files
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.glb'))
    .sort()[0];

  const obj = files
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.obj'))
    .sort()[0];

  const mtl = files
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith('.mtl'))
    .sort()[0];

  if (!glb && !obj) {
    return null;
  }

  const meta = (await readJsonIfExists([
    path.join(dirPath, 'meta.json'),
    path.join(objsDir, `${dirent.name}.meta.json`),
  ])) || {};

  const baseName = meta.name || dirent.name;
  const id = meta.id || deriveId(baseName);
  const title = meta.title || deriveTitle(baseName);

  const model = {
    id,
    title,
    scale: typeof meta.scale === 'number' ? meta.scale : 1,
    autoRotateSpeed: typeof meta.autoRotateSpeed === 'number' ? meta.autoRotateSpeed : 0.25,
  };

  if (typeof meta.yOffset === 'number') {
    model.yOffset = meta.yOffset;
  }

  if (glb) {
    model.glb = toPosixPath(path.join('objs', dirent.name, glb));
  } else {
    model.obj = toPosixPath(path.join('objs', dirent.name, obj));
    if (mtl) {
      model.mtl = toPosixPath(path.join('objs', dirent.name, mtl));
    }
  }

  return model;
}

async function collectFileModel(dirent) {
  const lower = dirent.name.toLowerCase();
  if (!lower.endsWith('.glb')) {
    return null;
  }

  const filePath = path.join(objsDir, dirent.name);
  const baseName = dirent.name.replace(/\.[^.]+$/, '');

  const meta = (await readJsonIfExists([
    `${filePath}.meta.json`,
    path.join(objsDir, `${baseName}.meta.json`),
  ])) || {};

  const displayName = meta.name || baseName;
  const id = meta.id || deriveId(displayName);
  const title = meta.title || deriveTitle(displayName);

  const model = {
    id,
    title,
    glb: toPosixPath(path.join('objs', dirent.name)),
    scale: typeof meta.scale === 'number' ? meta.scale : 1,
    autoRotateSpeed: typeof meta.autoRotateSpeed === 'number' ? meta.autoRotateSpeed : 0.25,
  };

  if (typeof meta.yOffset === 'number') {
    model.yOffset = meta.yOffset;
  }

  return model;
}

async function buildManifest() {
  const entries = await fs.readdir(objsDir, { withFileTypes: true });
  const models = [];

  const sortedEntries = entries
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  for (const entry of sortedEntries) {
    let model = null;
    if (entry.isDirectory()) {
      model = await collectDirectoryModel(entry);
    } else if (entry.isFile()) {
      model = await collectFileModel(entry);
    }

    if (model) {
      models.push(model);
    }
  }

  const outputPath = path.join(projectRoot, 'models.json');
  await fs.writeFile(outputPath, `${JSON.stringify(models, null, 2)}\n`, 'utf8');
  console.log(`[manifest] Wrote ${models.length} models to models.json`);
}

const shouldWatch = process.argv.includes('--watch');

async function runBuild() {
  try {
    await buildManifest();
  } catch (error) {
    console.error('[manifest] Failed to build manifest:', error);
  }
}

async function main() {
  await runBuild();

  if (!shouldWatch) {
    return;
  }

  console.log('[manifest] Watching objs/ for changes... (Ctrl+C to stop)');

  let timeoutId = null;
  const scheduleBuild = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = null;
      runBuild();
    }, 200);
  };

  let watcher;
  try {
    watcher = watch(objsDir, { recursive: true }, (_eventType, filename) => {
      if (shouldIgnoreChange(filename)) {
        return;
      }
      scheduleBuild();
    });
  } catch (error) {
    console.warn('[manifest] Recursive watch not supported on this platform. Watching top-level only.');
    watcher = watch(objsDir, (_eventType, filename) => {
      if (shouldIgnoreChange(filename)) {
        return;
      }
      scheduleBuild();
    });
  }

  const teardown = () => {
    watcher.close();
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    process.exit(0);
  };

  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
}

main().catch((error) => {
  console.error('[manifest] Unhandled error:', error);
  process.exitCode = 1;
});
