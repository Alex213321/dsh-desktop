// DSH Desktop — Electron shell for the official DeepSeek Harness Web GUI.
// Responsibilities of this shell, and nothing more:
//   1. spawn `npx --yes @deepseek-ai/dsh web --no-open` silently (no console
//      window) when the local DSH service is not already running; `--yes`
//      auto-confirms so version updates download without a prompt;
//   2. show http://127.0.0.1:3080 in a desktop window — the exact web UI,
//      no injected menus, no changed features;
//   3. live in the system tray: closing the window hides it, the service
//      keeps running, clicking the tray icon reopens the window.
'use strict';

const { app, BrowserWindow, Tray, Menu, Notification, dialog, shell, protocol, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const https = require('node:https');

// Built-in skin: the bundled anime wallpaper is served through this scheme.
// Privileges must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'wallpaper',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

// --- built-in skin: wallpaper registry + settings --------------------------
const WALLPAPERS = [
  { id: 'anime-girl', name: '二次元-动漫女孩', file: path.join(__dirname, 'assets', 'wallpapers', 'anime-girl.mp4') },
  { id: 'idle', name: '爱工作的女孩', file: path.join(__dirname, 'assets', 'wallpapers', 'idle.mp4') },
  { id: 'shuilingling', name: '水灵灵', file: path.join(__dirname, 'assets', 'wallpapers', 'shuilingling.mp4') },
  { id: 'xiantiaofeng', name: '线条风', file: path.join(__dirname, 'assets', 'wallpapers', 'xiantiaofeng.mp4') },
  { id: 'hongseliliang', name: '红色力量', file: path.join(__dirname, 'assets', 'wallpapers', 'hongseliliang.png') },
  { id: 'shuimochenpingan', name: '水墨陈平安', file: path.join(__dirname, 'assets', 'wallpapers', 'shuimochenpingan.mp4') },
  { id: 'daoke', name: '刀客', file: path.join(__dirname, 'assets', 'wallpapers', 'daoke.mp4') },
];

function wallpaperKind(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === '.mp4' || ext === '.webm' ? 'video' : 'image';
}

function wallpaperMime(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.avif') return 'image/avif';
  return 'application/octet-stream';
}

const SKIN_PROFILE_DEFAULTS = {
  bgBaseAlpha: 35, // 主背景不透明度 %
  surfaceAlpha: 45, // 面板/侧栏不透明度 %
  overlayAlpha: 60, // 弹层不透明度 %
  veil: 8, // 深色遮罩 %
  brightness: 104, // 视频亮度 %
};

const SKIN_DEFAULT_CURRENT = 'idle';

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeProfile(raw) {
  const next = { ...SKIN_PROFILE_DEFAULTS };
  if (raw && typeof raw === 'object') {
    next.bgBaseAlpha = clampNum(raw.bgBaseAlpha, 20, 100, SKIN_PROFILE_DEFAULTS.bgBaseAlpha);
    next.surfaceAlpha = clampNum(raw.surfaceAlpha, 25, 100, SKIN_PROFILE_DEFAULTS.surfaceAlpha);
    next.overlayAlpha = clampNum(raw.overlayAlpha, 30, 100, SKIN_PROFILE_DEFAULTS.overlayAlpha);
    next.veil = clampNum(raw.veil, 0, 30, SKIN_PROFILE_DEFAULTS.veil);
    next.brightness = clampNum(raw.brightness, 80, 120, SKIN_PROFILE_DEFAULTS.brightness);
  }
  return next;
}

// Every wallpaper keeps its own parameter profile, persisted independently.
function sanitizeSkinConfig(raw) {
  const next = { currentId: SKIN_DEFAULT_CURRENT, profiles: {} };
  // Migrate the legacy flat shape: apply its values to every profile.
  const legacy = raw && typeof raw === 'object' && typeof raw.profiles !== 'object' ? raw : null;
  for (const w of WALLPAPERS) {
    const source = legacy || (raw && raw.profiles && raw.profiles[w.id]) || null;
    next.profiles[w.id] = sanitizeProfile(source);
  }
  if (raw && WALLPAPERS.some((w) => w.id === raw.currentId)) next.currentId = raw.currentId;
  return next;
}

let skinConfig = sanitizeSkinConfig(null);

function skinConfigPath() {
  return path.join(app.getPath('userData'), 'skin-config.json');
}

function loadSkinConfig() {
  try {
    skinConfig = sanitizeSkinConfig(JSON.parse(fs.readFileSync(skinConfigPath(), 'utf8')));
  } catch {}
}

function saveSkinConfig() {
  try {
    fs.writeFileSync(skinConfigPath(), JSON.stringify(skinConfig, null, 2));
  } catch {}
}

function skinPayload() {
  return {
    currentId: skinConfig.currentId,
    profile: { ...skinConfig.profiles[skinConfig.currentId] },
    wallpapers: WALLPAPERS.map(({ id, name, file }) => ({ id, name, kind: wallpaperKind(file) })),
  };
}

// Portable: the official DSH service runs with this working directory
// (sessions are keyed by it). Defaults to the app folder itself.
const WORKSPACE_DIR = process.env.DSH_WORKSPACE || __dirname;
const DSH_URL = 'http://127.0.0.1:3080';
const DSH_PORT = 3080;
const LOAD_RETRY_MS = 1000;
const SLOW_START_NOTICE_MS = 20 * 1000;
const MIN_LOADING_MS = 1200; // keep the loading screen visible at least this long

// The DSH web service prints an authentication URL on startup
// (`dsh web: http://127.0.0.1:3080/?token=...`). Since the 0.1.2 line the
// service refuses to serve index.html until that per-process token is
// exchanged for a session cookie, so the shell must load the tokenized URL.
let webBase = DSH_URL; // actual base of the service we are talking to
let launchToken = null; // per-process token printed by the service
let serviceOutTail = ''; // rolling buffer so a split token line still matches
let fallbackUsed = false;

let win = null;
let tray = null;
let dshProcess = null;
let spawnedByApp = false;
let serverReady = false;
let quitting = false;
let hideNoticeShown = false;
let loadingPhase = true;
let currentStatus = '正在启动 DSH 服务…';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const iconPath = (name) => path.join(__dirname, 'assets', name);
const logPath = () => path.join(__dirname, 'logs', 'server.log');

// Optional portable userData override (used for sandboxed testing and
// portable setups); defaults to the standard per-user app data directory.
if (process.env.DSH_USERDATA_DIR) {
  app.setPath('userData', process.env.DSH_USERDATA_DIR);
}

const boundsPath = () => path.join(app.getPath('userData'), 'window-bounds.json');

// --- single instance: a second launch focuses the existing window instead ---
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
  app.setAppUserModelId('com.dsh.desktop');
  main();
}

function main() {
  app.whenReady().then(async () => {
    const loadingStarted = Date.now();
    loadSkinConfig();

    // Custom window controls (the frame is removed; buttons live in the UI).
    ipcMain.handle('window:minimize', () => {
      if (win && !win.isDestroyed()) win.minimize();
      return { ok: true };
    });
    ipcMain.handle('window:maximize', () => {
      if (!win || win.isDestroyed()) return { ok: true };
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return { ok: true };
    });
    ipcMain.handle('window:close', () => {
      if (win && !win.isDestroyed()) win.close(); // routes through hide-to-tray
      return { ok: true };
    });

    // --- info panel: DSH version + DeepSeek API balance ----------------------
    const dshHomeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

    function readDshVersion() {
      try {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const cacheRoot = path.join(localAppData, 'npm-cache', '_npx');
        let best = null;
        for (const entry of fs.readdirSync(cacheRoot)) {
          const pkg = path.join(cacheRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
          if (!fs.existsSync(pkg)) continue;
          const mtime = fs.statSync(pkg).mtimeMs;
          if (!best || mtime > best.mtimeMs) {
            best = { mtimeMs: mtime, version: JSON.parse(fs.readFileSync(pkg, 'utf8')).version };
          }
        }
        return best ? best.version : '';
      } catch {
        return '';
      }
    }

    function readApiKey() {
      try {
        const text = fs.readFileSync(path.join(dshHomeDir, '.credentials.yaml'), 'utf8');
        const m = text.match(/sk-[A-Za-z0-9]{16,}/);
        return m ? m[0] : '';
      } catch {
        return '';
      }
    }

    function hasApiKey() {
      return readApiKey().length > 0;
    }

    ipcMain.handle('shell:get-info', () => ({ version: readDshVersion() }));

    ipcMain.handle('info:get-balance', () =>
      new Promise((resolve) => {
        const key = readApiKey();
        if (!key) {
          resolve({ ok: false, reason: '未找到 API Key' });
          return;
        }
        const req = https.get(
          'https://api.deepseek.com/user/balance',
          { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } },
          (res) => {
            let data = '';
            res.on('data', (chunk) => {
              data += chunk;
            });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                const infos = json.balance_infos || [];
                const cny = infos.find((b) => b.currency === 'CNY') || infos[0];
                if (cny && cny.total_balance !== undefined) {
                  resolve({ ok: true, balance: String(cny.total_balance), currency: cny.currency || 'CNY' });
                } else {
                  resolve({ ok: false, reason: json.message || '响应格式异常' });
                }
              } catch {
                resolve({ ok: false, reason: '响应解析失败' });
              }
            });
          }
        );
        req.on('error', (error) => resolve({ ok: false, reason: error.message }));
        req.setTimeout(15000, () => {
          req.destroy();
          resolve({ ok: false, reason: '请求超时' });
        });
      })
    );

    // Skin IPC: read/write the skin configuration, broadcast on change.
    ipcMain.handle('skin:get-config', () => skinPayload());
    ipcMain.handle('skin:set-config', (_event, patch) => {
      if (patch && typeof patch === 'object') {
        if (WALLPAPERS.some((w) => w.id === patch.currentId)) skinConfig.currentId = patch.currentId;
        if (patch.params && typeof patch.params === 'object') {
          const cur = skinConfig.currentId;
          skinConfig.profiles[cur] = sanitizeProfile({ ...skinConfig.profiles[cur], ...patch.params });
        }
      }
      saveSkinConfig();
      const payload = skinPayload();
      if (win && !win.isDestroyed()) win.webContents.send('skin:config', payload);
      return payload;
    });

    // Serve bundled wallpaper assets to the injected skin layers.
    // 'wallpaper://skin/video/anime-girl' → host='skin', pathname='/video/anime-girl'.
    // Range requests read ONLY the requested bytes (no full-file slurps), so
    // big wallpapers stream cheaply and switching stays smooth.
    function serveMedia(file, mime, request) {
      const stat = fs.statSync(file);
      const range = request.headers.get('range');
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        const start = m && m[1] ? parseInt(m[1], 10) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
          return new Response(null, {
            status: 416,
            headers: { 'content-range': 'bytes */' + stat.size },
          });
        }
        const length = end - start + 1;
        const buf = Buffer.allocUnsafe(length);
        const fd = fs.openSync(file, 'r');
        try {
          fs.readSync(fd, buf, 0, length, start);
        } finally {
          fs.closeSync(fd);
        }
        return new Response(buf, {
          status: 206,
          headers: {
            'content-type': mime,
            'content-range': 'bytes ' + start + '-' + end + '/' + stat.size,
            'accept-ranges': 'bytes',
            'cache-control': 'no-cache',
          },
        });
      }
      return new Response(fs.readFileSync(file), {
        headers: { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' },
      });
    }

    protocol.handle('wallpaper', (request) => {
      try {
        const url = new URL(request.url);
        const key = url.host + url.pathname;
        if (key === 'skin/current') {
          const body = fs.readFileSync(path.join(__dirname, 'assets', 'wallpaper.jpg'));
          return new Response(body, {
            headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-cache' },
          });
        }
        if (key === 'skin/fab') {
          return serveMedia(path.join(__dirname, 'assets', 'fab.webm'), 'video/webm', request);
        }
        if (key === 'skin/info-fab') {
          return serveMedia(path.join(__dirname, 'assets', 'info-fab.webm'), 'video/webm', request);
        }
        const videoMatch = /^skin\/video\/([A-Za-z0-9_-]+)$/.exec(key);
        if (videoMatch) {
          const wallpaper = WALLPAPERS.find((w) => w.id === videoMatch[1]);
          if (!wallpaper) return new Response('not found', { status: 404 });
          const mime = wallpaperMime(wallpaper.file);
          return serveMedia(wallpaper.file, mime, request);
        }
        return new Response('not found', { status: 404 });
      } catch {
        return new Response('bad request', { status: 500 });
      }
    });
    // First-run setup: no API key yet → show the key-entry page first.
    let appStarted = false;
    const startApp = async () => {
      if (appStarted) return;
      appStarted = true;
      const loadingStarted = Date.now();
      await ensureServer();
      setLoadingStatus('服务已就绪，正在进入界面…');
      const elapsed = Date.now() - loadingStarted;
      if (elapsed < MIN_LOADING_MS) await sleep(MIN_LOADING_MS - elapsed);
      loadWithRetry();
    };

    ipcMain.handle('setup:save-key', async (_event, apiKey) => {
      const key = String(apiKey || '').trim();
      if (!/^sk-[A-Za-z0-9]{16,}$/.test(key)) {
        return { ok: false, reason: '密钥格式不正确（应以 sk- 开头）' };
      }
      try {
        fs.mkdirSync(dshHomeDir, { recursive: true });
        const credPath = path.join(dshHomeDir, '.credentials.yaml');
        let text = '';
        try {
          text = fs.readFileSync(credPath, 'utf8');
        } catch {}
        if (/refs\s*:/.test(text)) {
          text = text.replace(/(DEEPSEEK_API_KEY\s*:\s*)[^\r\n]*/, '$1' + key);
        } else {
          text = (text.trim() ? text.trim() + '\n' : '') + 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ' + key + '\n';
        }
        fs.writeFileSync(credPath, text);
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
      if (win && !win.isDestroyed()) {
        win.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
      }
      startApp();
      return { ok: true };
    });

    const needSetup = !hasApiKey();
    createTray();
    createWindow(needSetup);
    if (!needSetup) startApp();
  });

  app.on('activate', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  // The tray keeps the app alive; closing the last window must not quit.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    killDshChild();
  });
}

function isPortOpen(port = DSH_PORT) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Start the official dsh web service only when it is not already running
// (e.g. already started by the desktop "DSH" shortcut). --yes lets npx
// download new versions without asking; --no-open keeps the default browser
// closed: this Electron window is the only UI we open.
//
// Since dsh 0.1.2-rc.1 the service answers 401 until its per-process launch
// token (printed as `dsh web: http://127.0.0.1:<port>/?token=...`) is
// exchanged for a session cookie, so every load must carry the token.

function captureServiceOutput(text) {
  serviceOutTail = (serviceOutTail + text).slice(-8192);
  if (launchToken) return;
  // Match the loopback URL; the optional trailing LAN copy is ignored.
  let match;
  const re = /(http:\/\/127\.0\.0\.1:\d+)\/\?token=([A-Za-z0-9_-]+)/g;
  while ((match = re.exec(serviceOutTail))) {
    webBase = match[1];
    launchToken = match[2];
  }
}

function readLastLaunchToken() {
  try {
    const text = fs.readFileSync(logPath(), 'utf8');
    const re = /127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/g;
    let match;
    let token = null;
    while ((match = re.exec(text))) token = match[1];
    return token;
  } catch {
    return null;
  }
}

function dshUrl() {
  return launchToken ? `${webBase}/?token=${launchToken}` : webBase;
}

// The 303 See Other answer from `/?token=...` proves the token belongs to
// the service currently listening on that port.
async function tokenProbe(base, token) {
  try {
    const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual', cache: 'no-store' });
    return res.status === 303;
  } catch {
    return false;
  }
}

async function waitForPort(port) {
  while (!quitting && !(await isPortOpen(port))) await sleep(300);
  return !quitting;
}

async function spawnService(extraArgs) {
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  } catch {}
  const logStream = fs.createWriteStream(logPath(), { flags: 'a' });
  logStream.write(
    `\n[${new Date().toISOString()}] starting: npx --yes @deepseek-ai/dsh web --no-open${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}\n`
  );
  setLoadingStatus('正在启动 DSH 服务…');

  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  try {
    dshProcess = spawn(npx, ['--yes', '@deepseek-ai/dsh', 'web', '--no-open', ...extraArgs], {
      cwd: WORKSPACE_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true, // Windows: .cmd files can only be spawned through a shell
    });
  } catch (error) {
    logStream.write(`${error}\n`);
    logStream.end();
    showStartupError();
    return false;
  }
  spawnedByApp = true;

  const onData = (chunk) => {
    const text = chunk.toString();
    logStream.write(text);
    captureServiceOutput(text);
  };
  dshProcess.stdout.on('data', onData);
  dshProcess.stderr.on('data', onData);

  // New versions can take minutes to download on first launch; tell the
  // user what is happening instead of failing silently.
  let slowNoticeShown = false;
  const slowTimer = setInterval(() => {
    if (!slowNoticeShown) {
      slowNoticeShown = true;
      setLoadingStatus('检测到新版本，正在下载，请稍候…');
      try {
        if (tray && typeof tray.displayBalloon === 'function') {
          tray.displayBalloon({
            title: 'DSH',
            content: '正在准备 DSH 服务（首次启动或版本更新时需要下载，请稍候）…',
            iconType: 'info',
          });
        }
      } catch {}
    }
  }, SLOW_START_NOTICE_MS);

  dshProcess.on('exit', (code) => {
    clearInterval(slowTimer);
    logStream.write(`[${new Date().toISOString()}] npx exited with code ${code}\n`);
    logStream.end();
    if (quitting) return;
    spawnedByApp = false;
    dshProcess = null;
    if (serverReady && tray) tray.setToolTip('DSH（本地服务已停止）');
  });

  // Wait for the announced URL (it carries the launch token); npx may
  // legitimately be downloading a new version first, so there is no
  // arbitrary timeout. A real failure exits the child and reports below.
  // Also accept the port coming up without a URL line (a profile with
  // printUrl disabled, or an old service version): the session cookie may
  // still authenticate it, and checkAuthFallback() covers a denial.
  const expectedPort = extraArgs.length ? null : DSH_PORT;
  let portSeenAt = null;
  while (!quitting && dshProcess && !launchToken) {
    if (expectedPort && (await isPortOpen(expectedPort))) {
      if (portSeenAt === null) portSeenAt = Date.now();
      // The URL line is printed right after the port comes up (server ready
      // → announce); give it a short grace period before concluding the
      // service never prints one (printUrl disabled / old version).
      if (Date.now() - portSeenAt > 8000) break;
    }
    await sleep(250);
  }
  if (!launchToken) {
    if (!quitting && !(expectedPort && (await isPortOpen(expectedPort)))) {
      showStartupError();
      return false;
    }
    serverReady = true;
    logStream.write(`[${new Date().toISOString()}] server ready on ${expectedPort ? 'http://127.0.0.1:' + String(expectedPort) : '?'} (no token line)\n`);
    if (tray) tray.setToolTip('DSH');
    setLoadingStatus('服务已就绪，正在进入界面…');
    return true;
  }
  clearInterval(slowTimer);

  const port = Number(new URL(webBase).port);
  if (!(await waitForPort(port))) return false;
  serverReady = true;
  logStream.write(`[${new Date().toISOString()}] server ready on ${webBase}\n`);
  if (tray) tray.setToolTip('DSH');
  setLoadingStatus('服务已就绪，正在进入界面…');
  return true;
}

async function ensureServer() {
  if (await isPortOpen(DSH_PORT)) {
    // Something already serves 3080. If a previous instance of this app
    // started it, its launch token is the last one in the log — verify it
    // first, because a foreign `dsh web` (e.g. the dev server) has its own
    // token.
    const logToken = readLastLaunchToken();
    if (logToken && (await tokenProbe(DSH_URL, logToken))) {
      launchToken = logToken;
      serverReady = true;
      return;
    }
    // No verified token: start our own service on an OS-assigned port right
    // away, while the loading screen is still up, so the window opens the
    // real UI directly instead of flashing through an empty 401 page.
    await spawnService(['--port', '0']);
    return;
  }
  await spawnService([]);
}

// If the app could not authenticate an already-running service (port 3080
// belongs to a foreign `dsh web`, or the session cookie expired), start the
// service on an OS-assigned port instead of leaving the window empty.
async function checkAuthFallback() {
  if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return;
  if (fallbackUsed || !serverReady) return;
  let url = '';
  try {
    url = win.webContents.getURL();
  } catch {}
  if (!url.startsWith(webBase)) return;
  const denied = await win.webContents
    .executeJavaScript(`document.body && /authentication required/i.test(document.body.innerText)`)
    .catch(() => false);
  if (!denied) return;
  if (launchToken) {
    // The token arrived after the plain load started (the URL line is
    // printed a moment after the port opens): reload with it instead of
    // starting yet another service.
    loadWithRetry();
    return;
  }
  fallbackUsed = true;
  goLoading(`端口 ${DSH_PORT} 已被其他 DSH 服务占用，正在改用空闲端口…`);
  const ok = await spawnService(['--port', '0']);
  if (!ok || quitting || !win || win.isDestroyed()) return;
  setLoadingStatus('服务已就绪，正在进入界面…');
  loadWithRetry();
}

function showStartupError() {
  let tail = '';
  try {
    const lines = fs.readFileSync(logPath(), 'utf8').split('\n');
    tail = lines.slice(-12).join('\n');
  } catch {}
  dialog.showErrorBox(
    'DSH 启动失败',
    `无法启动本地 DSH 服务。\n\n${tail || '（无日志）'}\n\n日志文件：${logPath()}`
  );
}

// Built-in skin: inject the wallpaper layers + switcher into the Web GUI.
// The local loading page (file:) keeps its own artwork untouched.
let skinCssCache = null;
let skinJsCache = null;

function injectSkin(wc) {
  if (!wc || wc.isDestroyed()) return;
  let url = '';
  try {
    url = wc.getURL();
  } catch {}
  if (url.startsWith('file:')) return;
  try {
    if (skinCssCache === null) skinCssCache = fs.readFileSync(path.join(__dirname, 'skin-client.css'), 'utf8');
    if (skinJsCache === null) skinJsCache = fs.readFileSync(path.join(__dirname, 'skin-client.js'), 'utf8');
  } catch {
    return;
  }
  if (skinCssCache) wc.insertCSS(skinCssCache).catch(() => {});
  if (skinJsCache) wc.executeJavaScript(skinJsCache).catch(() => {});
}

function loadWithRetry() {
  win.loadURL(dshUrl())
    .then(() => {
      loadingPhase = false;
      if (!win.isDestroyed()) win.show();
    })
    .catch(() => {
      if (quitting) return;
      goLoading('连接中断，正在重试…');
      setTimeout(loadWithRetry, LOAD_RETRY_MS);
    });
}

// --- loading screen helpers -----------------------------------------------
// The loading page is a local, offline file; status text is pushed into it
// with executeJavaScript (no preload/IPC needed).
function setLoadingStatus(text) {
  currentStatus = text;
  applyLoadingStatus();
}

function applyLoadingStatus() {
  if (!win || win.isDestroyed() || !loadingPhase) return;
  win.webContents
    .executeJavaScript(
      `window.__setLoading && window.__setLoading(${JSON.stringify(currentStatus)})`
    )
    .catch(() => {});
}

function goLoading(text) {
  loadingPhase = true;
  currentStatus = text;
  win.loadFile(path.join(__dirname, 'loading.html')).catch(() => {});
}

function createWindow(showSetup) {
  let bounds = {};
  try {
    bounds = JSON.parse(fs.readFileSync(boundsPath(), 'utf8'));
  } catch {}

  win = new BrowserWindow({
    width: bounds.width || 1360,
    height: bounds.height || 860,
    x: bounds.x,
    y: bounds.y,
    title: 'DSH',
    icon: iconPath('app.ico'),
    show: false,
    autoHideMenuBar: true,
    frame: false, // custom window controls are injected into the web UI
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenu(buildMenu());
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    if (loadingPhase) applyLoadingStatus();
    win.show();
    injectSkin(win.webContents);
    checkAuthFallback().catch(() => {});
  });

  // First-run key entry page, or the normal loading screen.
  win.loadFile(path.join(__dirname, showSetup ? 'first-run.html' : 'loading.html')).catch(() => {});

  // Close = hide to tray (service keeps running).
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
      if (!hideNoticeShown) {
        hideNoticeShown = true;
        showHideNotice();
      }
    }
  });

  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  // Links that point outside the app open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Closing-to-tray hint: prefer the tray balloon on Windows (reliable in
// unpackaged apps), fall back to a system notification elsewhere.
function showHideNotice() {
  const body = 'DSH 仍在后台运行，单击系统托盘图标即可重新打开窗口。';
  try {
    if (tray && typeof tray.displayBalloon === 'function') {
      tray.displayBalloon({ title: 'DSH', content: body, iconType: 'info' });
      return;
    }
    new Notification({ title: 'DSH', body }).show();
  } catch {}
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
  try {
    fs.writeFileSync(boundsPath(), JSON.stringify(win.getBounds()));
  } catch {}
}

function createTray() {
  tray = new Tray(iconPath('app.ico'));
  tray.setToolTip('DSH');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开 DSH',
        click: () => {
          if (win) {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          killDshChild();
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [{ role: 'quit', label: '退出' }],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '在浏览器中打开 Web 版',
          click: () => shell.openExternal(dshUrl()),
        },
      ],
    },
  ]);
}

// Only kill the service process that THIS app started. If the service was
// already running before launch, leave it alone.
function killDshChild() {
  if (dshProcess && spawnedByApp) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(dshProcess.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        dshProcess.kill('SIGTERM');
      }
    } catch {}
    dshProcess = null;
    spawnedByApp = false;
  }
}
