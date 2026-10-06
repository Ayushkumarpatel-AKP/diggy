/**
 * Page snapshot with an optional highlighted region.
 *
 * `captureWithHighlight` must be called from the BACKGROUND (a service worker
 * or an extension page) because `chrome.tabs.captureVisibleTab` is only
 * available there. It grabs the visible tab, draws it into an `OffscreenCanvas`,
 * paints a soft dark scrim outside the requested region and strokes a rounded
 * red rectangle around it, then returns a `data:image/png` URL.
 *
 * Everything degrades gracefully: if the API, the canvas, image decoding or
 * the crop is unavailable, it returns the original (uncropped) capture.
 */

export interface SnapshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotOptions {
  /** Region of interest in CSS pixels (viewport coordinates). */
  rect?: SnapshotRect;
  /** Crop the image to the highlighted region, or keep the full viewport. */
  cropTo?: 'viewport' | 'highlight';
  /** CSS px → device px factor (pass `devicePixelRatio`). Defaults to 1. */
  scale?: number;
}

/** Loose typing for the bit of `chrome.tabs` we use — no @types/chrome needed. */
interface TabsLike {
  captureVisibleTab?: (
    windowId?: number,
    options?: { format?: 'png' | 'jpeg'; quality?: number },
  ) => Promise<string>;
}

/** Extra device-pixel margin kept around the highlight when cropping. */
const CROP_MARGIN = 16;
/** Padding added around the stroked rectangle, in device pixels. */
const STROKE_PADDING = 6;
const STROKE_WIDTH = 4;
const CORNER_RADIUS = 12;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/** Call `chrome.tabs.captureVisibleTab` if present; never throws. */
async function captureVisibleTab(): Promise<string | undefined> {
  const chromeObj = (globalThis as unknown as { chrome?: { tabs?: TabsLike } }).chrome;
  const tabs = chromeObj?.tabs;
  const capture = tabs?.captureVisibleTab;
  if (!tabs || typeof capture !== 'function') return undefined;
  try {
    const result = await capture.call(tabs);
    return typeof result === 'string' && result ? result : undefined;
  } catch {
    return undefined;
  }
}

/** Decode a data URL into an ImageBitmap; `undefined` if unavailable. */
async function decodeCapture(dataUrl: string): Promise<ImageBitmap | undefined> {
  try {
    if (typeof createImageBitmap !== 'function') return undefined;
    const blob = await (await fetch(dataUrl)).blob();
    return await createImageBitmap(blob);
  } catch {
    return undefined;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return `data:${blob.type || 'image/png'};base64,${encodeBase64(new Uint8Array(buffer))}`;
}

/** Add a rounded-rectangle subpath to the current path. */
function addRoundRect(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Scrim outside the padded region + rounded red stroke around it. */
function drawHighlight(
  ctx: OffscreenCanvasRenderingContext2D,
  rect: SnapshotRect,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const x = rect.x - STROKE_PADDING;
  const y = rect.y - STROKE_PADDING;
  const width = rect.width + STROKE_PADDING * 2;
  const height = rect.height + STROKE_PADDING * 2;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
  ctx.beginPath();
  ctx.rect(0, 0, canvasWidth, canvasHeight);
  addRoundRect(ctx, x, y, width, height, CORNER_RADIUS);
  ctx.fill('evenodd');
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = '#ef4444';
  ctx.lineWidth = STROKE_WIDTH;
  ctx.beginPath();
  addRoundRect(ctx, x, y, width, height, CORNER_RADIUS);
  ctx.stroke();
  ctx.restore();
}

/**
 * Capture the visible tab, optionally crops to / highlights `rect`, and
 * returns a `data:image/png` URL. Returns the uncropped capture (or `''` when
 * even that is unavailable) rather than throwing.
 */
export async function captureWithHighlight(options: SnapshotOptions = {}): Promise<string> {
  const raw = await captureVisibleTab();
  if (!raw) return '';

  try {
    const source = await decodeCapture(raw);
    if (!source || typeof OffscreenCanvas === 'undefined') return raw;

    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const scale = options.scale && options.scale > 0 ? options.scale : 1;
    const rect = options.rect;

    let cropX = 0;
    let cropY = 0;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;
    let highlight: SnapshotRect | undefined;

    if (rect && rect.width > 0 && rect.height > 0) {
      const rx = clamp(rect.x * scale, 0, sourceWidth);
      const ry = clamp(rect.y * scale, 0, sourceHeight);
      const rw = clamp(rect.width * scale, 0, sourceWidth - rx);
      const rh = clamp(rect.height * scale, 0, sourceHeight - ry);

      if (options.cropTo === 'highlight') {
        const left = clamp(rx - CROP_MARGIN, 0, sourceWidth);
        const top = clamp(ry - CROP_MARGIN, 0, sourceHeight);
        const right = clamp(rx + rw + CROP_MARGIN, 0, sourceWidth);
        const bottom = clamp(ry + rh + CROP_MARGIN, 0, sourceHeight);
        cropX = left;
        cropY = top;
        cropWidth = Math.max(1, right - left);
        cropHeight = Math.max(1, bottom - top);
        highlight = { x: rx - cropX, y: ry - cropY, width: rw, height: rh };
      } else {
        highlight = { x: rx, y: ry, width: rw, height: rh };
      }
    }

    const width = Math.max(1, Math.round(cropWidth));
    const height = Math.max(1, Math.round(cropHeight));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return raw;

    ctx.drawImage(source, cropX, cropY, cropWidth, cropHeight, 0, 0, width, height);
    if (highlight) drawHighlight(ctx, highlight, width, height);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(blob);
  } catch {
    return raw;
  }
}
