import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ReferenceBank } from './bank.js';
import { emptyConnection, inspectCodex, publicError, type ReadyCodex } from './codex.js';
import { collect, makeDetection } from './collect.js';
import type { Connection, DesktopState, Detection } from './types.js';

const PRODUCT_NAME = 'OpenSosen Model Fingerprint';
const WINDOW_TITLE = 'OpenSosen 模型指纹';

app.setName(PRODUCT_NAME);
app.setAppUserModelId('OpenSosen.ModelFingerprint');

let window: BrowserWindow | null = null;
let connection: Connection = emptyConnection('checking');
let detection: Detection | null = null;
let ready: ReadyCodex | null = null;
let refreshing: Promise<void> | null = null;
let active: { controller: AbortController; done: Promise<void> } | null = null;
let quitting = false;
const lifetime = new AbortController();
const bank = new ReferenceBank(join(app.getPath('userData'), 'reference'), publish);

function state(): DesktopState {
  return { connection, bank: bank.state, detection };
}

function publish() {
  if (window && !window.isDestroyed()) window.webContents.send('fingerprint:state', state());
}

function refreshConnection() {
  if (active || lifetime.signal.aborted) return;
  if (refreshing) return refreshing;
  connection = { ...connection, state: 'checking', message: null };
  publish();
  refreshing = inspectCodex(lifetime.signal).then((result) => {
    ready = result.ready;
    connection = result.connection;
  }).catch((error: unknown) => {
    ready = null;
    connection = emptyConnection('error', publicError(error));
  }).finally(() => {
    refreshing = null;
    publish();
  });
  return refreshing;
}

function markUnsent(run: Detection, cancelled: boolean, message: string | null) {
  run.status = cancelled ? 'cancelled' : 'failed';
  run.message = message;
  run.finishedAt = new Date().toISOString();
  for (const sample of run.samples) {
    if (sample.status === 'queued') {
      sample.status = cancelled ? 'cancelled' : 'failed';
      sample.error = message;
    }
  }
}

function start(modelId: unknown) {
  const prior = ready;
  if (lifetime.signal.aborted || active || refreshing || connection.state !== 'ready' || !prior || typeof modelId !== 'string') return false;
  const model = prior.connection.models.find(({ id }) => id === modelId);
  if (!model) return false;

  const run = detection = makeDetection(prior, model);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  const done = (async () => {
    const inspected = await inspectCodex(signal);
    if (signal.aborted) { markUnsent(run, true, null); return; }
    const current = ready = inspected.ready;
    connection = inspected.connection;
    const currentModel = current?.connection.models.find(({ id }) => id === modelId);
    if (!current || !currentModel || current.connection.account !== prior.connection.account ||
      current.connection.version !== prior.connection.version || currentModel.effort !== model.effort ||
      JSON.stringify(current.routeConfig) !== JSON.stringify(prior.routeConfig)) {
      markUnsent(run, false, inspected.connection.message ?? 'Codex 登录、模型或路由已变化，请核对界面后重新开始。');
      return;
    }
    await collect(current, currentModel, run, { signal, update: publish, bank: () => bank.snapshot });
  })().catch((error: unknown) => {
    markUnsent(run, signal.aborted, signal.aborted ? null : publicError(error));
  }).finally(() => {
    active = null;
    publish();
  });
  active = { controller, done };
  publish();
  return true;
}

async function exportEvidence() {
  const current = detection;
  if (!current || current.status === 'running') return { path: null };
  const name = current.model.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 70);
  const dir = join(app.getPath('documents'), PRODUCT_NAME, '证据');
  const path = join(dir, `opensosen-model-fingerprint-${name}-${current.startedAt.slice(0, 10)}-${current.id.slice(0, 8)}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify({
      format: 'opensosen-model-fingerprint-v1',
      responseModel: null,
      routeBasis: 'Codex provider metadata and process configuration',
      responseTransport: 'Codex exec JSONL reports assistant text and turn status',
      detection: current,
    }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { path };
  } catch {
    return { path: null };
  }
}

function registerIpc() {
  const handlers = {
    'fingerprint:read': state,
    'fingerprint:refresh-connection': refreshConnection,
    'fingerprint:refresh-bank': () => bank.refresh(),
    'fingerprint:start': start,
    'fingerprint:cancel': () => { active?.controller.abort(); },
    'fingerprint:export': exportEvidence,
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, arg?: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) return;
      return handler(arg);
    });
  }
}

function createWindow() {
  const current = new BrowserWindow({
    title: WINDOW_TITLE, width: 1110, height: 850,
    minWidth: 620, minHeight: 540, backgroundColor: '#f1f4f7', show: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  window = current;
  current.removeMenu();
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', (event) => event.preventDefault());
  current.webContents.session.setPermissionRequestHandler((_, __, answer) => answer(false));
  current.once('ready-to-show', () => current.show());
  current.on('closed', () => { window = null; });
  void current.loadFile(join(__dirname, 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    lifetime.abort();
    if (quitting || (!refreshing && !active)) return;
    event.preventDefault();
    quitting = true;
    void Promise.allSettled([refreshing, active?.done]).then(() => app.quit());
  });
  void app.whenReady().then(() => {
    registerIpc();
    createWindow();
    void refreshConnection();
    void bank.refresh();
  });
}
