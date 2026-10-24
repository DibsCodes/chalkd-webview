import { contentBounds } from './board.js';
import { paintBoard } from './render.js';

/** Lower than the app's 10%, so even a long stack of PDF pages fits. */
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;
const FIT_MARGIN_PX = 48;
/** Zoom buttons and keys step by this factor. */
const ZOOM_STEP = 1.25;
/** A fling keeps gliding, losing this fraction of its speed per ms. */
const FRICTION = 0.004;

export function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * A pan-and-zoom view of one board on a canvas. No editing: one finger or
 * the mouse drags the board, two fingers pinch, the wheel scrolls, and
 * Ctrl+wheel (or a touchpad pinch) zooms.
 */
export class Viewer {
  /** (x, y) is the world point at the top-left corner of the canvas. */
  camera = { x: 0, y: 0, zoom: 1 };
  onZoom = () => {};

  #canvas;
  #ctx;
  #board = null;
  #bitmaps = new Map();
  #width = 0;
  #height = 0;
  #dpr = 1;
  #dirty = true;
  #frame = 0;
  #pointers = new Map();
  #gesture = null;
  #velocity = { x: 0, y: 0 };
  #glide = null;
  #animation = null;
  #safariZoom = 1;
  #resizeObserver;
  #cleanup = [];

  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d', { alpha: false });
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas);
    this.#listen();
    this.#resize();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  show(board, bitmaps) {
    this.#board = board;
    this.#bitmaps = bitmaps;
    this.#stopMotion();
    this.fitContent(false);
  }

  clear() {
    this.#board = null;
    this.#bitmaps = new Map();
    this.#stopMotion();
  }

  // ---------- view commands ----------

  /** Show everything on the board, never zooming in past 100%. */
  fitContent(animate = true) {
    const b = this.#board && contentBounds(this.#board.items);
    if (!b) {
      this.#goTo(this.#centeredOn({ x: 0, y: 0 }, 1), animate);
      return;
    }
    const w = Math.max(1, this.#width - FIT_MARGIN_PX * 2);
    const h = Math.max(1, this.#height - FIT_MARGIN_PX * 2);
    const zoom = clampZoom(
      Math.min(1, w / (b.maxX - b.minX || 1), h / (b.maxY - b.minY || 1)),
    );
    const center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    this.#goTo(this.#centeredOn(center, zoom), animate);
  }

  /** Zoom to 100%, keeping the middle of the screen where it is. */
  zoomToActual() {
    this.#goTo(this.#centeredOn(this.#screenCenterWorld(), 1), true);
  }

  zoomIn() {
    this.#zoomByStep(ZOOM_STEP);
  }

  zoomOut() {
    this.#zoomByStep(1 / ZOOM_STEP);
  }

  /** Pan by a screen distance (arrow keys). */
  nudge(dx, dy) {
    const target = { ...this.camera };
    target.x += dx / target.zoom;
    target.y += dy / target.zoom;
    this.#goTo(target, true);
  }

  // ---------- camera ----------

  #zoomAt(sx, sy, zoom) {
    const cam = this.camera;
    const ax = sx / cam.zoom + cam.x;
    const ay = sy / cam.zoom + cam.y;
    cam.zoom = clampZoom(zoom);
    cam.x = ax - sx / cam.zoom;
    cam.y = ay - sy / cam.zoom;
    this.#changed();
  }

  #panBy(dsx, dsy) {
    this.camera.x -= dsx / this.camera.zoom;
    this.camera.y -= dsy / this.camera.zoom;
    this.#changed();
  }

  #zoomByStep(factor) {
    const base = this.#animation?.to ?? this.camera;
    const zoom = clampZoom(base.zoom * factor);
    const cx = this.#width / 2;
    const cy = this.#height / 2;
    const ax = cx / base.zoom + base.x;
    const ay = cy / base.zoom + base.y;
    this.#goTo({ x: ax - cx / zoom, y: ay - cy / zoom, zoom }, true);
  }

  #screenCenterWorld() {
    const cam = this.camera;
    return {
      x: cam.x + this.#width / 2 / cam.zoom,
      y: cam.y + this.#height / 2 / cam.zoom,
    };
  }

  #centeredOn(world, zoom) {
    return {
      x: world.x - this.#width / 2 / zoom,
      y: world.y - this.#height / 2 / zoom,
      zoom,
    };
  }

  #goTo(target, animate) {
    this.#stopMotion();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate || reduce) {
      Object.assign(this.camera, target);
      this.#changed();
      return;
    }
    this.#animation = {
      from: { ...this.camera },
      to: target,
      start: performance.now(),
      duration: 220,
    };
    this.#dirty = true;
  }

  #stopMotion() {
    this.#animation = null;
    this.#glide = null;
  }

  #changed() {
    this.#dirty = true;
    this.onZoom(this.camera.zoom);
  }

  // ---------- drawing ----------

  #resize() {
    const rect = this.#canvas.getBoundingClientRect();
    const firstSize = this.#width === 0;
    // Keep the middle of the screen in place as the window changes size.
    const center = firstSize ? null : this.#screenCenterWorld();
    this.#dpr = window.devicePixelRatio || 1;
    this.#width = rect.width;
    this.#height = rect.height;
    this.#canvas.width = Math.max(1, Math.round(rect.width * this.#dpr));
    this.#canvas.height = Math.max(1, Math.round(rect.height * this.#dpr));
    if (center) Object.assign(this.camera, this.#centeredOn(center, this.camera.zoom));
    else if (this.#board) this.fitContent(false);
    this.#dirty = true;
  }

  #tick = (now) => {
    this.#frame = requestAnimationFrame(this.#tick);
    if ((window.devicePixelRatio || 1) !== this.#dpr) this.#resize();

    const anim = this.#animation;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / anim.duration);
      const e = 1 - (1 - t) ** 3;
      // Interpolate zoom geometrically so it feels even in and out.
      const zoom = anim.from.zoom * (anim.to.zoom / anim.from.zoom) ** e;
      // Move the screen center in a straight line.
      const fc = this.#centerOf(anim.from);
      const tc = this.#centerOf(anim.to);
      Object.assign(
        this.camera,
        this.#centeredOn(
          { x: fc.x + (tc.x - fc.x) * e, y: fc.y + (tc.y - fc.y) * e },
          zoom,
        ),
      );
      if (t >= 1) {
        Object.assign(this.camera, anim.to);
        this.#animation = null;
      }
      this.#changed();
    }

    const glide = this.#glide;
    if (glide) {
      const dt = Math.min(64, now - glide.last);
      glide.last = now;
      const decay = Math.exp(-FRICTION * dt);
      glide.vx *= decay;
      glide.vy *= decay;
      this.#panBy(glide.vx * dt, glide.vy * dt);
      if (Math.hypot(glide.vx, glide.vy) < 0.02) this.#glide = null;
    }

    if (this.#dirty && this.#board) {
      this.#dirty = false;
      paintBoard(
        this.#ctx,
        this.#board,
        this.#bitmaps,
        this.camera,
        this.#width,
        this.#height,
        this.#dpr,
      );
    }
  };

  #centerOf(cam) {
    return {
      x: cam.x + this.#width / 2 / cam.zoom,
      y: cam.y + this.#height / 2 / cam.zoom,
    };
  }

  // ---------- input ----------

  #listen() {
    const el = this.#canvas;
    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.#cleanup.push(() => target.removeEventListener(type, fn, opts));
    };
    on(el, 'pointerdown', (e) => this.#pointerDown(e));
    on(el, 'pointermove', (e) => this.#pointerMove(e));
    on(el, 'pointerup', (e) => this.#pointerUp(e));
    on(el, 'pointercancel', (e) => this.#pointerUp(e, true));
    on(el, 'lostpointercapture', (e) => this.#pointerUp(e, true));
    on(el, 'wheel', (e) => this.#wheel(e), { passive: false });
    // Safari's touchpad pinch.
    on(el, 'gesturestart', (e) => this.#safariGesture(e), { passive: false });
    on(el, 'gesturechange', (e) => this.#safariGesture(e), { passive: false });
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  #local(e) {
    const r = this.#canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    e.preventDefault();
    this.#canvas.setPointerCapture(e.pointerId);
    this.#stopMotion();
    this.#pointers.set(e.pointerId, this.#local(e));
    this.#velocity = { x: 0, y: 0, t: e.timeStamp };
    this.#startGesture();
    this.#canvas.classList.add('grabbing');
  }

  #pointerMove(e) {
    if (!this.#pointers.has(e.pointerId)) return;
    this.#pointers.set(e.pointerId, this.#local(e));
    const g = this.#gesture;
    if (!g) return;
    const { center, spread } = this.#measure();
    const dx = center.x - g.center.x;
    const dy = center.y - g.center.y;
    if (g.spread && spread) {
      this.#zoomAt(center.x, center.y, this.camera.zoom * (spread / g.spread));
    }
    this.#panBy(dx, dy);

    // Smoothed speed in px/ms, for the glide after a fling.
    const dt = Math.max(1, e.timeStamp - this.#velocity.t);
    const k = Math.min(1, dt / 50);
    this.#velocity = {
      x: this.#velocity.x * (1 - k) + (dx / dt) * k,
      y: this.#velocity.y * (1 - k) + (dy / dt) * k,
      t: e.timeStamp,
    };
    g.center = center;
    g.spread = spread;
  }

  #pointerUp(e, cancelled = false) {
    if (!this.#pointers.has(e.pointerId)) return;
    this.#pointers.delete(e.pointerId);
    if (this.#pointers.size > 0) {
      this.#startGesture();
      return;
    }
    this.#gesture = null;
    this.#canvas.classList.remove('grabbing');
    const v = this.#velocity;
    const stale = e.timeStamp - v.t > 80;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!cancelled && !stale && !reduce && Math.hypot(v.x, v.y) > 0.3) {
      this.#glide = { vx: v.x, vy: v.y, last: performance.now() };
    }
  }

  /** (Re)start a gesture from the pointers that are down now. */
  #startGesture() {
    const { center, spread } = this.#measure();
    this.#gesture = { center, spread };
  }

  #measure() {
    const pts = [...this.#pointers.values()];
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p.x;
      y += p.y;
    }
    const center = { x: x / pts.length, y: y / pts.length };
    let spread = 0;
    if (pts.length >= 2) {
      for (const p of pts) spread += Math.hypot(p.x - center.x, p.y - center.y);
      spread /= pts.length;
    }
    return { center, spread };
  }

  #wheel(e) {
    e.preventDefault();
    this.#stopMotion();
    const { x, y } = this.#local(e);
    // Lines or pages instead of pixels (Firefox with a mouse wheel).
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.#height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey) {
      // Ctrl+wheel is also what a touchpad pinch produces: many small deltas
      // instead of a few big mouse-wheel notches, so it needs more gain.
      const gain = Math.abs(dy) >= 50 ? 0.002 : 0.01;
      this.#zoomAt(x, y, this.camera.zoom * Math.exp(-dy * gain));
    } else if (e.shiftKey && dx === 0) {
      this.#panBy(-dy, 0);
    } else {
      this.#panBy(-dx, -dy);
    }
  }

  #safariGesture(e) {
    e.preventDefault();
    // On iPhone and iPad a pinch also arrives as pointers; those win.
    if (this.#pointers.size > 0) return;
    const { x, y } = this.#local(e);
    if (e.type === 'gesturestart') {
      this.#safariZoom = this.camera.zoom;
      return;
    }
    this.#zoomAt(x, y, this.#safariZoom * e.scale);
  }

  dispose() {
    cancelAnimationFrame(this.#frame);
    this.#resizeObserver.disconnect();
    for (const fn of this.#cleanup) fn();
  }
}
