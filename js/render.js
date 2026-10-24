/**
 * Drawing a board, matching the Chalkd app (src/renderer/engine/ink.ts,
 * draw.ts and background.ts): round-capped ink through point midpoints,
 * images under highlighter under pen, and a pattern that coarsens as you
 * zoom out.
 */

// ---------- ink ----------

const shapeCache = new WeakMap();

function inkShape(points, width) {
  const path = new Path2D();
  const n = points.length / 2;
  if (n === 0) return { path, dot: true };
  if (isDot(points, width)) {
    path.arc(points[0], points[1], width / 2, 0, Math.PI * 2);
    return { path, dot: true };
  }
  path.moveTo(points[0], points[1]);
  if (n === 2) {
    path.lineTo(points[2], points[3]);
    return { path, dot: false };
  }
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    path.quadraticCurveTo(
      x,
      y,
      (x + points[i * 2 + 2]) / 2,
      (y + points[i * 2 + 3]) / 2,
    );
  }
  path.lineTo(points[(n - 1) * 2], points[(n - 1) * 2 + 1]);
  return { path, dot: false };
}

/** A tap, or a stroke that never left a tiny circle, is a round dot. */
function isDot(points, width) {
  const limit = Math.max(0.75, width * 0.25);
  for (let i = 2; i < points.length; i += 2) {
    if (
      Math.abs(points[i] - points[0]) > limit ||
      Math.abs(points[i + 1] - points[1]) > limit
    ) {
      return false;
    }
  }
  return true;
}

function drawStroke(ctx, item) {
  let shape = shapeCache.get(item);
  if (!shape) {
    shape = inkShape(item.points, item.width);
    shapeCache.set(item, shape);
  }
  ctx.save();
  ctx.translate(item.origin.x, item.origin.y);
  ctx.globalAlpha = item.opacity;
  if (shape.dot) {
    ctx.fillStyle = item.color;
    ctx.fill(shape.path);
  } else {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = item.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // One stroke() call paints the whole path once, so a highlighter
    // crossing itself doesn't get darker where it overlaps.
    ctx.stroke(shape.path);
  }
  ctx.restore();
}

function drawImage(ctx, item, bitmaps) {
  const bitmap = bitmaps.get(item.asset);
  ctx.globalAlpha = 1;
  if (!bitmap) {
    // Missing or unreadable: a soft placeholder of the right size.
    ctx.fillStyle = 'rgba(128, 140, 160, 0.15)';
    ctx.fillRect(item.x, item.y, item.w, item.h);
    return;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, item.x, item.y, item.w, item.h);
}

// ---------- background ----------

function drawPattern(ctx, bg, view, zoom) {
  const { color, pattern } = bg;
  if (pattern === 'blank') return;
  const spacing = patternSpacing(bg, zoom);
  const x0 = Math.floor(view.minX / spacing) * spacing;
  const y0 = Math.floor(view.minY / spacing) * spacing;
  const dark = luminance(color) < 0.4;
  ctx.beginPath();

  if (pattern === 'dots') {
    const r = 1.25 / zoom;
    for (let y = y0; y <= view.maxY; y += spacing) {
      for (let x = x0; x <= view.maxX; x += spacing) {
        ctx.rect(x - r, y - r, r * 2, r * 2);
      }
    }
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(30,45,70,0.26)';
    ctx.fill();
    return;
  }

  if (pattern === 'grid') {
    for (let x = x0; x <= view.maxX; x += spacing) {
      ctx.moveTo(x, view.minY);
      ctx.lineTo(x, view.maxY);
    }
  }
  for (let y = y0; y <= view.maxY; y += spacing) {
    ctx.moveTo(view.minX, y);
    ctx.lineTo(view.maxX, y);
  }
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(30,45,70,0.11)';
  ctx.lineWidth = 1 / zoom;
  ctx.stroke();
}

/** Pattern spacing in world units at this zoom (coarser when zoomed out). */
function patternSpacing(bg, zoom) {
  const minScreenGap = bg.pattern === 'dots' ? 16 : 10;
  let spacing = bg.spacing > 0 ? bg.spacing : 40;
  while (spacing * zoom < minScreenGap) spacing *= 5;
  return spacing;
}

export function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function intersects(a, b) {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

/**
 * Paint a board at camera { x, y, zoom } ((x, y) is the world point at the
 * top-left corner) onto a canvas `width` × `height` CSS pixels at `scale`
 * device pixels per CSS pixel.
 */
export function paintBoard(ctx, board, bitmaps, camera, width, height, scale) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = board.background.color;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  const z = camera.zoom * scale;
  ctx.setTransform(z, 0, 0, z, -camera.x * z, -camera.y * z);
  const view = {
    minX: camera.x,
    minY: camera.y,
    maxX: camera.x + width / camera.zoom,
    maxY: camera.y + height / camera.zoom,
  };
  drawPattern(ctx, board.background, view, camera.zoom);
  for (const item of board.items) {
    if (!intersects(item.bounds, view)) continue;
    if (item.type === 'stroke') drawStroke(ctx, item);
    else drawImage(ctx, item, bitmaps);
  }
}

/** Decode every picture on the board; unreadable ones are left out. */
export async function decodeAssets(assets) {
  const bitmaps = new Map();
  await Promise.all(
    [...assets].map(async ([hash, { mime, bytes }]) => {
      try {
        bitmaps.set(
          hash,
          await createImageBitmap(new Blob([bytes], { type: mime })),
        );
      } catch {
        // Drawn as a placeholder.
      }
    }),
  );
  return bitmaps;
}
