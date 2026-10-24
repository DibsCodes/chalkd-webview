/**
 * Reads a .chalkd board. A board is a SQLite database (see Chalkd's
 * src/main/board-file.ts); sql.js opens it in memory, read-only in practice.
 */

/** "CHLK": marks a SQLite file as a Chalkd board (PRAGMA application_id). */
const APPLICATION_ID = 0x43484c4b;
/** The newest board format this viewer understands (PRAGMA user_version). */
const FORMAT_VERSION = 1;

export const DEFAULT_BACKGROUND = {
  color: '#ffffff',
  pattern: 'dots',
  spacing: 40,
};

export class BoardError extends Error {}

let sqlPromise = null;

/** Load sql.js (and its WebAssembly) the first time a board is opened. */
function loadSql() {
  if (!sqlPromise) {
    sqlPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'vendor/sql.js/sql-wasm.js';
      script.onload = () =>
        window
          .initSqlJs({ locateFile: (f) => `vendor/sql.js/${f}` })
          .then(resolve, reject);
      script.onerror = () =>
        reject(new Error('Could not load the board reader.'));
      document.head.appendChild(script);
    }).catch((err) => {
      sqlPromise = null;
      throw err;
    });
  }
  return sqlPromise;
}

/**
 * Parse a board's bytes into { background, camera, items, assets }.
 * Items come back in render order: images, then highlighters, then pen ink.
 */
export async function readBoard(bytes) {
  const SQL = await loadSql();
  let db;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new BoardError("This file isn't a Chalkd board.");
  }
  try {
    let appId, version;
    try {
      appId = pragma(db, 'application_id');
      version = pragma(db, 'user_version');
    } catch {
      throw new BoardError("This file isn't a Chalkd board.");
    }
    if (appId !== APPLICATION_ID)
      throw new BoardError("This file isn't a Chalkd board.");
    if (version > FORMAT_VERSION)
      throw new BoardError(
        `This board was saved by a newer version of Chalkd (format ${version}). Try updating the viewer.`,
      );

    const meta = { background: DEFAULT_BACKGROUND, camera: null };
    for (const [key, value] of rows(db, 'SELECT key, value FROM meta')) {
      if (key === 'background' || key === 'camera') {
        try {
          meta[key] = JSON.parse(value);
        } catch {
          // Leave the default.
        }
      }
    }
    meta.background = { ...DEFAULT_BACKGROUND, ...meta.background };

    const items = [];
    for (const row of rows(
      db,
      `SELECT type, kind, z, min_x, min_y, max_x, max_y,
              origin_x, origin_y, style, points
       FROM items ORDER BY z`,
    )) {
      const item = rowToItem(row);
      if (item) items.push(item);
    }
    items.sort(compareRenderOrder);

    const assets = new Map();
    for (const [hash, mime, data] of rows(
      db,
      'SELECT hash, mime, bytes FROM assets',
    )) {
      assets.set(hash, { mime, bytes: data });
    }

    return { ...meta, items, assets };
  } finally {
    db.close();
  }
}

function rowToItem([
  type,
  kind,
  z,
  minX,
  minY,
  maxX,
  maxY,
  originX,
  originY,
  styleJson,
  points,
]) {
  let style;
  try {
    style = JSON.parse(styleJson);
  } catch {
    return null;
  }
  const bounds = { minX, minY, maxX, maxY };
  if (type === 'image') {
    return {
      type: 'image',
      z,
      asset: style.asset,
      x: originX,
      y: originY,
      w: style.w,
      h: style.h,
      bounds,
    };
  }
  // Copy into a fresh, aligned buffer: SQLite blobs can start at any offset.
  const copy = points ? points.slice() : new Uint8Array(0);
  return {
    type: 'stroke',
    kind: kind === 'highlighter' ? 'highlighter' : 'pen',
    z,
    color: style.color,
    width: style.width,
    opacity: style.opacity ?? 1,
    origin: { x: originX, y: originY },
    points: new Float32Array(copy.buffer, 0, copy.byteLength >> 2),
    bounds,
  };
}

/** Layers draw bottom to top: images, highlighters, pen ink. */
function layerRank(item) {
  if (item.type === 'image') return 0;
  return item.kind === 'highlighter' ? 1 : 2;
}

function compareRenderOrder(a, b) {
  return layerRank(a) - layerRank(b) || a.z - b.z;
}

/** Bounding box of everything on the board, or null when empty. */
export function contentBounds(items) {
  if (!items.length) return null;
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { bounds } of items) {
    if (bounds.minX < b.minX) b.minX = bounds.minX;
    if (bounds.minY < b.minY) b.minY = bounds.minY;
    if (bounds.maxX > b.maxX) b.maxX = bounds.maxX;
    if (bounds.maxY > b.maxY) b.maxY = bounds.maxY;
  }
  return b;
}

function pragma(db, name) {
  const [result] = db.exec(`PRAGMA ${name}`);
  return Number(result?.values[0]?.[0] ?? 0);
}

function rows(db, sql) {
  const [result] = db.exec(sql);
  return result ? result.values : [];
}
