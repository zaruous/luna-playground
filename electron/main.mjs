import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { UsageEngine } from './usage/engine.mjs';
import { sendHookSignal } from './usage/hook-server.mjs';
import { CodexHookInstaller } from './usage/providers/codex/hooks.mjs';
import { quoteCommandPart } from './usage/utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const isHookInvocation = process.argv.includes('--nyangtracker-hook');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
    if (process.stdin.readableEnded) resolve(data);
  });
}

async function runHookInvocation() {
  const raw = await readStdin();
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch {}
  const signal = {
    hook_event_name: payload.hook_event_name ?? payload.hookEventName ?? payload.event ?? null,
    session_id: payload.session_id ?? payload.sessionId ?? null,
    turn_id: payload.turn_id ?? payload.turnId ?? null,
    transcript_path: payload.transcript_path ?? payload.transcriptPath ?? null,
    cwd: payload.cwd ?? null,
    model: payload.model ?? null,
  };
  await sendHookSignal(signal);
  process.exit(0);
}

if (isHookInvocation) {
  await runHookInvocation();
}

let usageEngine = null;
let hookInstaller = null;
let mainWindow = null;

function buildHookCommand() {
  if (app.isPackaged) return `${quoteCommandPart(process.execPath)} --nyangtracker-hook`;
  return `${quoteCommandPart(process.execPath)} ${quoteCommandPart(app.getAppPath())} --nyangtracker-hook`;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1450,
    height: 980,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: '#f9f4ec',
    title: '냥토큰 트래커',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('focus', () => usageEngine?.rescan().catch(() => {}));

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  mainWindow = win;
  return win;
}

function registerIpc() {
  ipcMain.handle('usage:get-snapshot', () => usageEngine?.snapshot() ?? null);
  ipcMain.handle('usage:rescan', () => usageEngine?.rescan() ?? null);
  ipcMain.handle('usage:get-diagnostics', () => usageEngine?.store.getDiagnostics() ?? null);
  ipcMain.handle('codex:hook-status', () => hookInstaller?.status() ?? null);
  ipcMain.handle('codex:install-hooks', () => hookInstaller?.install() ?? null);
  ipcMain.handle('codex:uninstall-hooks', () => hookInstaller?.uninstall() ?? null);
}

app.whenReady().then(async () => {
  usageEngine = new UsageEngine({ userDataPath: app.getPath('userData') });
  hookInstaller = new CodexHookInstaller({ command: buildHookCommand() });
  registerIpc();
  usageEngine.on('snapshot', (snapshot, reason) => {
    if (!mainWindow?.isDestroyed()) mainWindow.webContents.send('usage:snapshot', snapshot, reason ?? null);
  });
  await usageEngine.start();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  usageEngine?.stop().catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
