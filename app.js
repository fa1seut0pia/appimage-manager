#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const os = require('os');
const { pipeline } = require('stream/promises');
const { URL } = require('url');

const PORT = process.env.PORT || 18868;
const BASE_DIR = process.cwd();
const REMARKS_PATH = path.join(BASE_DIR, 'app-update.json');
const INDEX_PATH = process.pkg
  ? path.join(__dirname, 'app.html')
  : path.join(BASE_DIR, 'app.html');
const GITHUB_API = 'https://api.github.com';
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const DEFAULT_GITHUB_MIRROR = (process.env.GITHUB_MIRROR || '').trim(); // e.g. https://cors.isteed.cc/
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const ICON_CACHE_DIR = path.join(BASE_DIR, '.icon-cache');
const updateJobs = new Map();
const iconQueue = [];
const iconJobSet = new Set();
let iconProcessing = false;
const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || '');

function debugLog(...args) {
  if (!DEBUG) return;
  console.log('[debug]', ...args);
}

const config = {
  mirror: 'cors.isteed.cc',
  token: '',
  appimageDir: '',
};

function normalizeMirror(input) {
  if (!input) return '';
  let value = input.trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  if (!value.endsWith('/')) {
    value += '/';
  }
  return value;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.mirror === 'string') {
      config.mirror = parsed.mirror;
    }
    if (parsed && typeof parsed.token === 'string') {
      config.token = parsed.token;
    }
    if (parsed && typeof parsed.appimageDir === 'string') {
      config.appimageDir = parsed.appimageDir;
    }
  } catch {
    // ignore
  }
}

function saveConfig() {
  const data = {
    mirror: config.mirror,
    token: config.token,
    appimageDir: config.appimageDir,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getDefaultMirrorPrefix() {
  if (DEFAULT_GITHUB_MIRROR) return normalizeMirror(DEFAULT_GITHUB_MIRROR);
  return normalizeMirror(config.mirror);
}

function getGithubToken() {
  if (GITHUB_TOKEN) return GITHUB_TOKEN;
  return (config.token || '').trim();
}

function getAppImageDir() {
  const raw = (config.appimageDir || '').trim();
  if (!raw) return BASE_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(BASE_DIR, raw);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function listAppImages() {
  const appDir = getAppImageDir();
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    return [];
  }
  const files = fs.readdirSync(appDir).filter((f) => f.endsWith('.AppImage'));
  const updateUrls = readJsonFileSafe(REMARKS_PATH, []);
  const updateUrlMap = new Map(updateUrls.map((r) => [r.name, r.updateUrl || r.remark || '']));
  return files.map((name) => {
    const stat = fs.statSync(path.join(appDir, name));
    const sizeMb = (stat.size / 1024 / 1024);
    const prefix = name.split(/[-_]/)[0];
    const backupPath = path.join(appDir, `${name}.old`);
    return {
      name,
      type: 'file',
      size: Number(sizeMb.toFixed(1)),
      prefix,
      updateUrl: updateUrlMap.get(prefix) || '',
      mtime: stat.mtimeMs,
      hasBackup: fs.existsSync(backupPath),
      iconUrl: `/api/icon?file=${encodeURIComponent(name)}`,
    };
  });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sanitizeCacheKey(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function getMimeByExt(ext) {
  const lower = ext.toLowerCase();
  if (lower === '.svg') return 'image/svg+xml';
  if (lower === '.xpm') return 'image/x-xpixmap';
  return 'image/png';
}

function findDesktopFile(rootDir) {
  const candidates = [];
  try {
    const rootEntries = fs.readdirSync(rootDir).filter((f) => f.endsWith('.desktop'));
    candidates.push(...rootEntries.map((f) => path.join(rootDir, f)));
  } catch {}
  const appsDir = path.join(rootDir, 'usr', 'share', 'applications');
  if (fs.existsSync(appsDir)) {
    const entries = fs.readdirSync(appsDir).filter((f) => f.endsWith('.desktop'));
    candidates.push(...entries.map((f) => path.join(appsDir, f)));
  }
  const picked = candidates[0] || '';
  debugLog('desktop candidates', candidates, 'picked', picked);
  return picked;
}

function parseDesktopIcon(desktopPath) {
  if (!desktopPath || !fs.existsSync(desktopPath)) return '';
  const lines = fs.readFileSync(desktopPath, 'utf8').split(/\r?\n/);
  let inDesktopEntry = false;
  for (const line of lines) {
    if (line.startsWith('[')) {
      inDesktopEntry = line.trim() === '[Desktop Entry]';
      continue;
    }
    if (!inDesktopEntry) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('Icon=')) {
      const iconValue = line.slice('Icon='.length).trim();
      debugLog('desktop icon', iconValue, 'from', desktopPath);
      return iconValue;
    }
  }
  return '';
}

function resolveIconPath(rootDir, iconValue) {
  if (!iconValue) return '';
  const raw = iconValue.trim();
  if (!raw) return '';
  const hasExt = path.extname(raw);
  const cleaned = raw.startsWith('/') ? raw.slice(1) : raw;
  const directPath = path.join(rootDir, cleaned);
  if (hasExt && fs.existsSync(directPath)) {
    debugLog('icon direct hit', directPath);
    return directPath;
  }

  const candidates = [];
  if (hasExt) {
    candidates.push(directPath);
  } else {
    const exts = ['.png', '.svg', '.xpm'];
    const iconBase = raw.replace(/\.(png|svg|xpm)$/i, '');
    candidates.push(...exts.map((ext) => path.join(rootDir, `${iconBase}${ext}`)));
    candidates.push(...exts.map((ext) => path.join(rootDir, 'usr', 'share', 'pixmaps', `${iconBase}${ext}`)));
    const iconsRoot = path.join(rootDir, 'usr', 'share', 'icons');
    if (fs.existsSync(iconsRoot)) {
      const themes = fs.readdirSync(iconsRoot);
      for (const theme of themes) {
        const themeDir = path.join(iconsRoot, theme);
        if (!fs.existsSync(themeDir) || !fs.statSync(themeDir).isDirectory()) continue;
        const sizes = fs.readdirSync(themeDir);
        for (const size of sizes) {
          const appsDir = path.join(themeDir, size, 'apps');
          if (!fs.existsSync(appsDir)) continue;
          candidates.push(...exts.map((ext) => path.join(appsDir, `${iconBase}${ext}`)));
        }
      }
    }
  }

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      debugLog('icon resolved', filePath);
      return filePath;
    }
  }
  return '';
}

function scoreIconPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const extScore = ext === '.png' ? 3 : (ext === '.svg' ? 2 : 1);
  const sizeMatch = filePath.match(/(\d+)\s*x\s*(\d+)/);
  const sizeScore = sizeMatch ? Math.max(Number(sizeMatch[1]), Number(sizeMatch[2])) : 0;
  return extScore * 1000 + sizeScore;
}

function collectIconsInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  try {
    return fs.readdirSync(dirPath)
      .filter((f) => /\.(png|svg|xpm)$/i.test(f))
      .map((f) => path.join(dirPath, f));
  } catch {
    return [];
  }
}

function findFallbackIcon(rootDir) {
  const candidates = [];
  candidates.push(...collectIconsInDir(rootDir));
  candidates.push(...collectIconsInDir(path.join(rootDir, 'usr', 'share', 'pixmaps')));

  const iconsRoot = path.join(rootDir, 'usr', 'share', 'icons');
  if (fs.existsSync(iconsRoot)) {
    try {
      const themes = fs.readdirSync(iconsRoot);
      for (const theme of themes) {
        const themeDir = path.join(iconsRoot, theme);
        if (!fs.existsSync(themeDir) || !fs.statSync(themeDir).isDirectory()) continue;
        const sizes = fs.readdirSync(themeDir);
        for (const size of sizes) {
          const appsDir = path.join(themeDir, size, 'apps');
          candidates.push(...collectIconsInDir(appsDir));
        }
      }
    } catch {
      // ignore
    }
  }

  if (!candidates.length) return '';
  candidates.sort((a, b) => scoreIconPath(b) - scoreIconPath(a));
  const picked = candidates[0] || '';
  if (picked) debugLog('fallback icon', picked);
  return picked;
}

function cacheIconFromRoot(rootDir, cacheKey, mtimeMs) {
  const desktopPath = findDesktopFile(rootDir);
  const iconValue = parseDesktopIcon(desktopPath);
  let iconPath = resolveIconPath(rootDir, iconValue);
  if (!iconPath) {
    iconPath = findFallbackIcon(rootDir);
  }
  if (!iconPath) {
    debugLog('icon not found', cacheKey);
    return false;
  }
  const ext = path.extname(iconPath) || '.png';
  const cacheFile = path.join(ICON_CACHE_DIR, `${cacheKey}${ext}`);
  try {
    fs.copyFileSync(iconPath, cacheFile);
    const metaPath = path.join(ICON_CACHE_DIR, `${cacheKey}.json`);
    const meta = { mtime: mtimeMs, path: cacheFile, mime: getMimeByExt(ext) };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    debugLog('icon cached', cacheFile);
    return true;
  } catch {
    debugLog('icon cache failed', iconPath);
    return false;
  }
}

function withMountedAppImage(appPath, handler) {
  return new Promise((resolve) => {
    let mountDir = '';
    let buffer = '';
    const child = spawn(appPath, ['--appimage-mount'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve(false);
    }, 8000);

    const tryResolveFromTmp = () => {
      if (mountDir) return false;
      const tmpRoot = os.tmpdir();
      let entries = [];
      try {
        entries = fs.readdirSync(tmpRoot).filter((e) => e.startsWith('.mount_'));
      } catch {
        return false;
      }
      if (!entries.length) return false;
      const base = path.basename(appPath).replace(/\.AppImage$/i, '');
      const baseHint = base.slice(0, 6).toLowerCase();
      let best = null;
      for (const entry of entries) {
        const fullPath = path.join(tmpRoot, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isDirectory()) continue;
          const score = (entry.toLowerCase().includes(baseHint) ? 1 : 0) * 1e12 + stat.mtimeMs;
          if (!best || score > best.score) {
            best = { path: fullPath, score };
          }
        } catch {
          // ignore
        }
      }
      if (best && best.path) {
        mountDir = best.path;
        debugLog('mount dir (tmp scan)', mountDir, 'from', appPath);
        Promise.resolve()
          .then(() => handler(mountDir))
          .then((ok) => {
            clearTimeout(timeout);
            try { child.kill('SIGKILL'); } catch {}
            resolve(!!ok);
          })
          .catch(() => {
            clearTimeout(timeout);
            try { child.kill('SIGKILL'); } catch {}
            resolve(false);
          });
        return true;
      }
      return false;
    };

    const scanTimer = setInterval(() => {
      if (tryResolveFromTmp()) {
        clearInterval(scanTimer);
      }
    }, 120);

    const handleOutput = (chunk) => {
      if (mountDir) return;
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/(\/tmp\/\.mount[^\\s]*)/i) || line.match(/(\/[^\\s]+\.mount[^\\s]*)/i);
        const candidate = match ? match[1] : (line.startsWith('/') ? line : '');
        if (!candidate) continue;
        try {
          const stat = fs.statSync(candidate);
          if (stat.isDirectory()) {
            mountDir = candidate;
            break;
          }
          debugLog('mount dir invalid (not dir)', candidate);
        } catch {
          debugLog('mount dir invalid (missing)', candidate);
        }
      }
      if (!mountDir) return;
      debugLog('mount dir', mountDir, 'from', appPath);
      Promise.resolve()
        .then(() => handler(mountDir))
        .then((ok) => {
          clearTimeout(timeout);
          clearInterval(scanTimer);
          try { child.kill('SIGKILL'); } catch {}
          resolve(!!ok);
        })
        .catch(() => {
          clearTimeout(timeout);
          clearInterval(scanTimer);
          try { child.kill('SIGKILL'); } catch {}
          resolve(false);
        });
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', () => {
      clearTimeout(timeout);
      clearInterval(scanTimer);
      resolve(false);
    });

    child.on('close', () => {
      if (!mountDir) {
        clearTimeout(timeout);
        clearInterval(scanTimer);
        resolve(false);
      }
    });
  });
}

function getCachedIcon(appPath, mtimeMs) {
  ensureDir(ICON_CACHE_DIR);
  const cacheKey = sanitizeCacheKey(path.basename(appPath));
  const metaPath = path.join(ICON_CACHE_DIR, `${cacheKey}.json`);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.mtime === mtimeMs && meta.path && fs.existsSync(meta.path)) {
        return meta;
      }
    } catch {
      // ignore broken cache
    }
  }
  return null;
}

function enqueueIconExtraction(appPath, mtimeMs) {
  const cacheKey = sanitizeCacheKey(path.basename(appPath));
  const jobKey = `${cacheKey}:${mtimeMs}`;
  if (iconJobSet.has(jobKey)) return;
  iconJobSet.add(jobKey);
  iconQueue.push({ appPath, mtimeMs, cacheKey, jobKey });
  processIconQueue();
}

async function processIconQueue() {
  if (iconProcessing) return;
  const job = iconQueue.shift();
  if (!job) return;
  iconProcessing = true;
  ensureDir(ICON_CACHE_DIR);
  const { appPath, mtimeMs, cacheKey, jobKey } = job;
  const finalize = () => {
    iconJobSet.delete(jobKey);
    iconProcessing = false;
    setTimeout(processIconQueue, 50);
  };

  try {
    await withMountedAppImage(appPath, (mountDir) =>
      cacheIconFromRoot(mountDir, cacheKey, mtimeMs)
    );
  } catch {
    // ignore
  }
  finalize();
}

function isSafeFileName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name !== path.basename(name)) return false;
  if (!name.endsWith('.AppImage')) return false;
  return true;
}

function safeAssetName(assetName, assetUrl) {
  let name = assetName && assetName.trim();
  if (!name && assetUrl) {
    try {
      const u = new URL(assetUrl);
      name = path.basename(u.pathname);
    } catch {
      name = '';
    }
  }
  if (!name) return '';
  name = path.basename(name);
  if (!name.endsWith('.AppImage')) return '';
  return name;
}

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendText(res, 404, '未找到资源');
    return;
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeGithubUrl(inputUrl) {
  if (!inputUrl) return null;
  const raw = inputUrl.trim();
  if (!raw) return null;
  const marker = 'https://github.com/';
  if (raw.includes(marker) && !raw.startsWith(marker)) {
    return raw.slice(raw.indexOf(marker));
  }
  return raw;
}

function extractGithubRepo(inputUrl) {
  try {
    const url = normalizeGithubUrl(inputUrl);
    if (!url) return null;
    const u = new URL(url);
    if (u.hostname !== 'github.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

function extractVersion(str) {
  if (!str) return null;
  const m = str.match(/(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

function normalizeTagVersion(tag) {
  if (!tag) return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, '');
}

function compareVersions(a, b) {
  if (!a || !b) return 0;
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function applyMirror(url, mirrorPrefix) {
  if (!mirrorPrefix) return url;
  return mirrorPrefix + url;
}

function getDownloadMirrorPrefix(overrideMirror) {
  return normalizeMirror(overrideMirror) || getDefaultMirrorPrefix() || '';
}

function applyMirrorIfNeeded(url, mirrorPrefix) {
  if (!mirrorPrefix) return url;
  if (url.startsWith(mirrorPrefix)) return url;
  return applyMirror(url, mirrorPrefix);
}

async function fetchJson(url, mirrorPrefix) {
  const target = applyMirror(url, mirrorPrefix);
  const headers = {
    'User-Agent': 'AppImage-Update-Checker',
    'Accept': 'application/vnd.github+json',
  };
  const token = getGithubToken();
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  const res = await fetch(target, {
    headers,
  });
  if (!res.ok) {
    throw new Error(`上游请求失败：${res.status}`);
  }
  return res.json();
}

function pickAppImageAsset(appImages, localFileName) {
  if (!appImages.length) return null;
  const preferTokens = ['amd64', 'x86_64', 'x64', 'x86-64'];
  const lowerLocal = (localFileName || '').toLowerCase();
  const appBase = lowerLocal.split(/[-_]/)[0];

  let picked = appImages.find((a) =>
    preferTokens.some((t) => a.name.toLowerCase().includes(t))
  );
  if (picked) return picked;

  // If no arch token, prefer asset matching app name and avoid arm
  const nonArm = appImages.filter((a) => {
    const n = a.name.toLowerCase();
    return !n.includes('arm') && !n.includes('aarch64');
  });
  const nameMatch = nonArm.find((a) => a.name.toLowerCase().includes(appBase));
  if (nameMatch) return nameMatch;

  return appImages[0];
}

async function getGithubLatest(url, options = {}) {
  const repo = extractGithubRepo(url);
  if (!repo) return null;
  const apiUrl = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/releases/latest`;
  const data = await fetchJson(apiUrl, '');
  const tag = data.tag_name || data.name || '';
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const appImages = assets.filter((a) => typeof a.name === 'string' && a.name.endsWith('.AppImage'));
  const appImageAsset = pickAppImageAsset(appImages, options.localFileName);
  const rawAssetUrl = appImageAsset ? appImageAsset.browser_download_url : '';
  const mirrorPrefix = options.mirrorForAsset ? getDownloadMirrorPrefix(options.mirror) : '';
  return {
    tag,
    html_url: data.html_url || normalizeGithubUrl(url) || url,
    asset_name: appImageAsset ? appImageAsset.name : '',
    asset_url: rawAssetUrl ? applyMirror(rawAssetUrl, mirrorPrefix) : '',
  };
}

async function downloadToFileWithProgress(url, filePath, onProgress, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`下载失败：${res.status}`);
  }
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : null;
  const body = res.body;
  if (!body) {
    throw new Error('Empty download body');
  }
  let received = 0;
  onProgress(received, total);
  const progressTap = new Transform({
    transform(chunk, enc, cb) {
      received += chunk.length;
      onProgress(received, total);
      cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(body), progressTap, fs.createWriteStream(filePath));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/app.html')) {
    return serveStaticFile(res, INDEX_PATH, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    return sendJson(res, 200, listAppImages());
  }

  if (req.method === 'GET' && (pathname === '/api/update-urls' || pathname === '/api/remarks')) {
    const updateUrls = readJsonFileSafe(REMARKS_PATH, []);
    return sendJson(res, 200, updateUrls);
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const token = getGithubToken();
    const tokenSource = GITHUB_TOKEN ? 'env' : (config.token ? 'config' : '');
    return sendJson(res, 200, {
      mirror: config.mirror,
      token: tokenSource === 'config' ? token : '',
      tokenSet: !!token,
      tokenSource,
      appimageDir: config.appimageDir || '',
    });
  }

  if (req.method === 'GET' && pathname === '/api/icon') {
    const name = (url.searchParams.get('file') || '').trim();
    if (!isSafeFileName(name)) return sendJson(res, 400, { error: '文件名不合法' });
    const appPath = path.join(getAppImageDir(), name);
    if (!fs.existsSync(appPath)) return sendJson(res, 404, { error: '文件不存在' });
    const stat = fs.statSync(appPath);
    const meta = getCachedIcon(appPath, stat.mtimeMs);
    if (!meta || !meta.path) {
      enqueueIconExtraction(appPath, stat.mtimeMs);
      return sendJson(res, 202, { status: 'extracting' });
    }
    return serveStaticFile(res, meta.path, meta.mime || 'image/png');
  }

  if (req.method === 'POST' && pathname === '/api/config') {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body || '{}');
      const hasMirror = Object.prototype.hasOwnProperty.call(payload, 'mirror');
      const hasToken = Object.prototype.hasOwnProperty.call(payload, 'token');
      const hasAppimageDir = Object.prototype.hasOwnProperty.call(payload, 'appimageDir');
      if (hasMirror) {
        const mirror = typeof payload.mirror === 'string' ? payload.mirror : '';
        config.mirror = mirror.trim();
      }
      if (hasToken) {
        const token = typeof payload.token === 'string' ? payload.token : '';
        config.token = token.trim();
      }
      if (hasAppimageDir) {
        const appimageDir = typeof payload.appimageDir === 'string' ? payload.appimageDir : '';
        config.appimageDir = appimageDir.trim();
      }
      saveConfig();
      const tokenSource = GITHUB_TOKEN ? 'env' : (config.token ? 'config' : '');
      return sendJson(res, 200, {
        ok: true,
        mirror: config.mirror,
        tokenSet: !!getGithubToken(),
        tokenSource,
        appimageDir: config.appimageDir || '',
      });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'JSON 解析失败' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/check') {
    try {
      const name = (url.searchParams.get('file') || '').trim();
      if (!isSafeFileName(name)) return sendJson(res, 400, { error: '文件名不合法' });
      const files = listAppImages();
      const file = files.find((f) => f.name === name);
      if (!file) return sendJson(res, 404, { error: '文件不存在' });
      if (!file.updateUrl) return sendJson(res, 200, { status: 'no-update-url' });

      const latest = await getGithubLatest(file.updateUrl, { mirrorForAsset: false, localFileName: file.name });
      if (!latest) return sendJson(res, 200, { status: 'unsupported-update-url' });

      const localVersion = extractVersion(file.name);
      const latestVersion = extractVersion(latest.tag);
      const normalizedTag = normalizeTagVersion(latest.tag);
      let status = 'unknown';
      let matchedInName = false;
      if (normalizedTag && file.name.includes(normalizedTag)) {
        status = 'latest';
        matchedInName = true;
      } else if (localVersion && latestVersion) {
        const cmp = compareVersions(localVersion, latestVersion);
        status = (cmp < 0 ? 'outdated' : 'latest');
      }

      return sendJson(res, 200, {
        status,
        matchedInName,
        localVersion,
        latestVersion,
        latestTag: latest.tag,
        releaseUrl: latest.html_url,
        assetName: latest.asset_name,
        assetUrl: latest.asset_url,
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message || '检查失败' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/update') {
    let payload = {};
    try {
      const body = await parseBody(req);
      payload = JSON.parse(body || '{}');
      const name = (payload.file || '').trim();
      const downloadUrl = (payload.downloadUrl || '').trim();
      const mirror = (payload.mirror || '').trim();
      if (!isSafeFileName(name)) return sendJson(res, 400, { error: '文件名不合法' });

      const files = listAppImages();
      const file = files.find((f) => f.name === name);
      if (!file) return sendJson(res, 404, { error: '文件不存在' });
      let assetUrl = '';
      let assetName = '';
      if (downloadUrl) {
        if (!/^https?:\/\//i.test(downloadUrl)) return sendJson(res, 400, { error: '下载地址不合法' });
        const mirrorPrefix = getDownloadMirrorPrefix(mirror);
        assetUrl = applyMirrorIfNeeded(downloadUrl, mirrorPrefix);
        assetName = safeAssetName('', downloadUrl);
      } else {
        if (!file.updateUrl) return sendJson(res, 400, { error: '未设置更新地址' });
        const latest = await getGithubLatest(file.updateUrl, { mirrorForAsset: true, mirror, localFileName: file.name });
        if (!latest || !latest.asset_url) return sendJson(res, 400, { error: '未找到可用下载地址' });
        assetUrl = latest.asset_url;
        assetName = safeAssetName(latest.asset_name, latest.asset_url);
      }

      if (!assetName) return sendJson(res, 400, { error: '文件名不合法' });

      const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const controller = new AbortController();
      const job = {
        id: jobId,
        status: 'running',
        file: name,
        target: assetName,
        received: 0,
        total: null,
        message: '',
        assetUrl,
        controller,
      };
      updateJobs.set(jobId, job);

      (async () => {
        const appDir = getAppImageDir();
        const tempPath = path.join(appDir, `${assetName}.download`);
        const targetPath = path.join(appDir, assetName);
        try {
          await downloadToFileWithProgress(assetUrl, tempPath, (received, total) => {
            job.received = received;
            job.total = total;
          }, controller.signal);
          const backupTargetPath = `${targetPath}.old`;
          if (fs.existsSync(backupTargetPath)) {
            fs.unlinkSync(backupTargetPath);
          }
          if (fs.existsSync(targetPath)) {
            fs.renameSync(targetPath, backupTargetPath);
          }
          fs.renameSync(tempPath, targetPath);
          if (name !== assetName) {
            const oldPath = path.join(appDir, name);
            const backupOldPath = `${oldPath}.old`;
            if (fs.existsSync(backupOldPath)) {
              fs.unlinkSync(backupOldPath);
            }
            if (fs.existsSync(oldPath)) {
              fs.renameSync(oldPath, backupOldPath);
            }
          }
          job.status = 'done';
          job.file = assetName;
        } catch (err) {
          if (err && err.name === 'AbortError') {
            job.status = 'canceled';
            job.message = 'canceled';
          } else {
            job.status = 'error';
            job.message = err.message || '更新失败';
          }
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch {}
        }
      })();

      return sendJson(res, 202, { ok: true, jobId, assetUrl });
    } catch (err) {
      return sendJson(res, 500, {
        error: err.message || '更新失败',
        file: payload && payload.file ? payload.file : '',
        mirror: payload && payload.mirror ? payload.mirror : '',
      });
    }
  }

  if (req.method === 'GET' && pathname.startsWith('/api/update/')) {
    const id = decodeURIComponent(pathname.replace('/api/update/', '')).trim();
    if (!id) return sendJson(res, 400, { error: '任务ID不能为空' });
    const job = updateJobs.get(id);
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    const { controller, ...safeJob } = job;
    return sendJson(res, 200, safeJob);
  }

  if (req.method === 'POST' && pathname === '/api/update/cancel') {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body || '{}');
      const id = (payload.jobId || '').trim();
      if (!id) return sendJson(res, 400, { error: '任务ID不能为空' });
      const job = updateJobs.get(id);
      if (!job) return sendJson(res, 404, { error: '任务不存在' });
      if (job.status !== 'running') return sendJson(res, 400, { error: '任务未在运行中' });
      if (job.controller) {
        job.controller.abort();
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'JSON 解析失败' });
    }
  }

  if (req.method === 'POST' && (pathname === '/api/update-urls' || pathname === '/api/remarks')) {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body || '{}');
      const name = (payload.name || '').trim();
      const updateUrl = (payload.updateUrl || payload.remark || '').toString();

      if (!name) {
        return sendJson(res, 400, { error: '名称不能为空' });
      }

      const updateUrls = readJsonFileSafe(REMARKS_PATH, []);
      const existing = updateUrls.find((r) => r.name === name);
      if (existing) {
        existing.updateUrl = updateUrl;
      } else {
        updateUrls.push({ name, updateUrl });
      }
      writeJsonFile(REMARKS_PATH, updateUrls);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'JSON 解析失败' });
    }
  }

  if (req.method === 'DELETE' && (pathname.startsWith('/api/update-urls/') || pathname.startsWith('/api/remarks/'))) {
    const name = decodeURIComponent(pathname.replace('/api/update-urls/', '').replace('/api/remarks/', '')).trim();
    if (!name) return sendJson(res, 400, { error: '名称不能为空' });
    const updateUrls = readJsonFileSafe(REMARKS_PATH, []);
    const next = updateUrls.filter((r) => r.name !== name);
    writeJsonFile(REMARKS_PATH, next);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/files/')) {
    const name = decodeURIComponent(pathname.replace('/api/files/', '')).trim();
    if (!isSafeFileName(name)) return sendJson(res, 400, { error: '文件名不合法' });
    const filePath = path.join(getAppImageDir(), name);
    if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: '文件不存在' });
    fs.unlinkSync(filePath);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/restore') {
    try {
      const body = await parseBody(req);
      const payload = JSON.parse(body || '{}');
      const name = (payload.file || '').trim();
      if (!isSafeFileName(name)) return sendJson(res, 400, { error: '文件名不合法' });
      const filePath = path.join(getAppImageDir(), name);
      const backupPath = `${filePath}.old`;
      if (!fs.existsSync(backupPath)) return sendJson(res, 404, { error: '未找到旧版本备份' });
      const swapPath = `${filePath}.swap`;
      if (fs.existsSync(swapPath)) fs.unlinkSync(swapPath);
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, swapPath);
      }
      fs.renameSync(backupPath, filePath);
      if (fs.existsSync(swapPath)) {
        fs.renameSync(swapPath, backupPath);
      }
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'JSON 解析失败' });
    }
  }

  return sendText(res, 404, '未找到资源');
});

loadConfig();
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
