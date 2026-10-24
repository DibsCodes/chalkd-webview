import { BoardError, contentBounds, readBoard } from './board.js';
import { decodeAssets, paintBoard } from './render.js';
import {
  addRecent,
  clearRecent,
  getRecent,
  listRecent,
  loadRecentFile,
  removeRecent,
} from './recent.js';
import { Viewer } from './viewer.js';

const $ = (id) => document.getElementById(id);
const home = $('home');
const viewerEl = $('viewer');
const canvas = $('board');
const fileInput = $('file-input');
const recentSection = $('recent');
const recentList = $('recent-list');
const zoomReadout = $('zoom-readout');
const titleEl = $('board-title');
const busy = $('busy');
const dropOverlay = $('drop-overlay');
const toastEl = $('toast');

const THUMB_W = 480;
const THUMB_H = 300;

let viewer = null;
/** Bumped on every open, so a slow load can't replace a newer one. */
let openSeq = 0;
let thumbUrls = [];

// ---------- opening ----------

/** Show the file picker. */
async function pickFile() {
  if ('showOpenFilePicker' in window) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        id: 'chalkd',
        types: [
          {
            description: 'Chalkd boards',
            accept: { 'application/octet-stream': ['.chalkd'] },
          },
        ],
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // Blocked (e.g. inside a frame): use the plain picker.
      fileInput.click();
      return;
    }
    openFile(await handle.getFile(), { handle });
    return;
  }
  fileInput.click();
}

/**
 * Open a board from a File. `handle` (a FileSystemFileHandle) lets the
 * recent list reread it from disk later; `recentId` updates that entry.
 */
async function openFile(file, { handle = null, recentId = null, note = '' } = {}) {
  const seq = ++openSeq;
  const title = file.name.replace(/\.chalkd$/i, '');
  setBusy(true);
  try {
    const board = await readBoard(new Uint8Array(await file.arrayBuffer()));
    const bitmaps = await decodeAssets(board.assets);
    if (seq !== openSeq) return;

    showViewer(title);
    viewer.show(board, bitmaps);
    if (!history.state?.board) history.pushState({ board: true }, '');
    if (note) toast(note);

    const thumb = await thumbnail(board, bitmaps);
    await addRecent({ id: recentId, name: file.name, title, file, handle, thumb });
  } catch (err) {
    if (seq !== openSeq) return;
    console.error(err);
    toast(
      err instanceof BoardError
        ? err.message
        : `“${file.name}” couldn't be opened. Is it a Chalkd board?`,
      true,
    );
  } finally {
    if (seq === openSeq) setBusy(false);
  }
}

async function openRecent(id) {
  const entry = await getRecent(id).catch(() => null);
  if (!entry) {
    toast('That board is no longer in the list.', true);
    renderRecent();
    return;
  }
  const loaded = await loadRecentFile(entry);
  if (!loaded) {
    toast(`Open “${entry.name}” again with the Open button to view it.`, true);
    return;
  }
  const note =
    entry.handle && !loaded.fromDisk
      ? 'Showing the copy saved in this browser. The original file couldn’t be read.'
      : '';
  openFile(loaded.file, { handle: entry.handle, recentId: entry.id, note });
}

/** A small picture of the whole board for the recent list. */
async function thumbnail(board, bitmaps) {
  try {
    const c = document.createElement('canvas');
    c.width = THUMB_W;
    c.height = THUMB_H;
    const ctx = c.getContext('2d', { alpha: false });
    const w = THUMB_W / 2;
    const h = THUMB_H / 2;
    const b = contentBounds(board.items);
    const margin = 10;
    let camera = { x: -w / 2, y: -h / 2, zoom: 1 };
    if (b) {
      // Fit the width; a board taller than the card shows its top.
      const bw = b.maxX - b.minX || 1;
      const bh = b.maxY - b.minY || 1;
      const z = Math.min(1, (w - margin * 2) / bw);
      const fitsHeight = bh * z <= h - margin * 2;
      const cx = (b.minX + b.maxX) / 2;
      camera = {
        x: cx - w / 2 / z,
        y: fitsHeight ? (b.minY + b.maxY) / 2 - h / 2 / z : b.minY - margin / z,
        zoom: z,
      };
    }
    paintBoard(ctx, board, bitmaps, camera, w, h, 2);
    return await new Promise((resolve) => c.toBlob(resolve, 'image/webp', 0.82));
  } catch {
    return null;
  }
}

// ---------- screens ----------

function showViewer(title) {
  home.hidden = true;
  viewerEl.hidden = false;
  titleEl.textContent = title;
  document.title = `${title} · Chalkd Viewer`;
  if (!viewer) {
    viewer = new Viewer(canvas);
    viewer.onZoom = (zoom) => {
      zoomReadout.textContent = `${Math.round(zoom * 100)}%`;
    };
  }
  canvas.focus({ preventScroll: true });
}

function showHome() {
  openSeq++;
  setBusy(false);
  viewerEl.hidden = true;
  home.hidden = false;
  viewer?.clear();
  document.title = 'Chalkd Viewer';
  renderRecent();
}

function goHome() {
  if (history.state?.board) history.back();
  else showHome();
}

addEventListener('popstate', () => {
  if (!history.state?.board && !viewerEl.hidden) showHome();
});

// ---------- recent list ----------

async function renderRecent() {
  const entries = await listRecent();
  for (const url of thumbUrls) URL.revokeObjectURL(url);
  thumbUrls = [];
  recentList.replaceChildren(...entries.map(recentCard));
  recentSection.hidden = entries.length === 0;
}

function recentCard(entry) {
  const li = document.createElement('li');
  li.className = 'recent-card';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'recent-open';
  open.dataset.recent = entry.id;

  let thumb;
  if (entry.thumb) {
    thumb = document.createElement('img');
    const url = URL.createObjectURL(entry.thumb);
    thumbUrls.push(url);
    thumb.src = url;
    thumb.alt = '';
  } else {
    thumb = document.createElement('span');
    thumb.classList.add('empty');
    thumb.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H4zM8 20h8M12 16v4" /></svg>';
  }
  thumb.classList.add('recent-thumb');

  const meta = document.createElement('span');
  meta.className = 'recent-meta';
  const name = document.createElement('span');
  name.className = 'recent-name';
  name.textContent = entry.title || entry.name;
  name.title = entry.name;
  const when = document.createElement('span');
  when.className = 'recent-when';
  when.textContent = `Opened ${timeAgo(entry.openedAt)}`;
  meta.append(name, when);
  open.append(thumb, meta);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'recent-remove';
  remove.dataset.remove = entry.id;
  remove.setAttribute('aria-label', `Remove ${entry.title || entry.name} from the list`);
  remove.title = 'Remove from list';
  remove.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>';

  li.append(open, remove);
  return li;
}

function timeAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 7) return rtf.format(-Math.round(s / 86400), 'day');
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

recentList.addEventListener('click', async (e) => {
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    await removeRecent(remove.dataset.remove).catch(() => {});
    renderRecent();
    return;
  }
  const open = e.target.closest('[data-recent]');
  if (open) openRecent(open.dataset.recent);
});

// ---------- feedback ----------

function setBusy(on) {
  busy.hidden = !on;
}

let toastTimer = 0;
function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', error);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), error ? 6000 : 4000);
}

// ---------- buttons and keys ----------

const actions = {
  open: pickFile,
  home: goHome,
  'clear-recent': async () => {
    await clearRecent().catch(() => {});
    renderRecent();
  },
  'zoom-in': () => viewer?.zoomIn(),
  'zoom-out': () => viewer?.zoomOut(),
  'zoom-actual': () => viewer?.zoomToActual(),
  fit: () => viewer?.fitContent(),
};

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (btn) actions[btn.dataset.action]?.();
});

// Touch devices often can't match the extension, which greys every file out.
if (!matchMedia('(pointer: coarse)').matches) fileInput.accept = '.chalkd';
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) openFile(file);
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    pickFile();
    return;
  }
  if (viewerEl.hidden || !viewer) return;
  if (e.target instanceof HTMLInputElement) return;
  const step = e.shiftKey ? 240 : 80;
  const keys = {
    '+': () => viewer.zoomIn(),
    '=': () => viewer.zoomIn(),
    '-': () => viewer.zoomOut(),
    _: () => viewer.zoomOut(),
    0: () => viewer.zoomToActual(),
    1: () => viewer.fitContent(),
    ArrowLeft: () => viewer.nudge(-step, 0),
    ArrowRight: () => viewer.nudge(step, 0),
    ArrowUp: () => viewer.nudge(0, -step),
    ArrowDown: () => viewer.nudge(0, step),
    Escape: goHome,
  };
  const fn = keys[e.key];
  if (!fn || (e.altKey && !mod)) return;
  // Keep the browser's own Ctrl+arrow shortcuts; take over Ctrl +/−/0/1.
  if (mod && e.key.startsWith('Arrow')) return;
  e.preventDefault();
  fn();
});

// ---------- drag and drop ----------

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
  if (!item) return;
  // Ask for the handle now: it's only available during the drop event.
  const handlePromise = item.getAsFileSystemHandle?.().catch(() => null);
  const file = item.getAsFile();
  const handle = (await handlePromise) ?? null;
  if (file) openFile(file, { handle: handle?.kind === 'file' ? handle : null });
});

renderRecent();
