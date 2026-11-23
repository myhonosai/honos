import type { CreativeDesignElement, CreativeDesignPage, CreativeDesignSize } from '@hon/contracts';
import { FONT_STACKS, wrapText } from './model';
import { QR_QUIET, qrModules } from './qr';

/**
 * One painter for the editor canvas and for downloads, so what is on screen is what is exported. Units are the design's
 * own (points for print, pixels for screen); `scale` maps them to canvas pixels. Photos come from `images` by photo id;
 * a photo not loaded yet is drawn as a light placeholder.
 */
export type PhotoSource = CanvasImageSource & { width: number; height: number };
type Ctx = CanvasRenderingContext2D;

export function fontFor(e: Extract<CreativeDesignElement, { kind: 'text' }>): string {
  return `${e.italic ? 'italic ' : ''}${e.bold ? '700' : '400'} ${e.size}px ${FONT_STACKS[e.font]}`;
}

/**
 * `bleed` (design units) paints that much extra on every side, for print: the page origin moves in by the bleed and the
 * background fills the whole area, so items that run off the page edge carry on into the bleed.
 */
export function paintPage(ctx: Ctx, page: CreativeDesignPage, size: CreativeDesignSize, scale: number, images: ReadonlyMap<string, PhotoSource>, bleed = 0): void {
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, bleed * scale, bleed * scale);
  ctx.globalAlpha = 1;
  ctx.fillStyle = page.background;
  ctx.fillRect(-bleed, -bleed, size.width + 2 * bleed, size.height + 2 * bleed);
  for (const e of page.elements) paintElement(ctx, e, images);
  ctx.restore();
}

function paintElement(ctx: Ctx, e: CreativeDesignElement, images: ReadonlyMap<string, PhotoSource>): void {
  ctx.save();
  ctx.globalAlpha = e.opacity;
  if (e.rotation) {
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    ctx.translate(cx, cy); ctx.rotate(e.rotation * Math.PI / 180); ctx.translate(-cx, -cy);
  }
  switch (e.kind) {
    case 'rect': {
      ctx.beginPath();
      const r = Math.min(e.radius, e.w / 2, e.h / 2);
      if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(e.x, e.y, e.w, e.h, r); else ctx.rect(e.x, e.y, e.w, e.h);
      fillStroke(ctx, e.fill, e.stroke, e.strokeWidth);
      break;
    }
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2);
      fillStroke(ctx, e.fill, e.stroke, e.strokeWidth);
      break;
    case 'line':
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x + e.w, e.y + e.h);
      ctx.strokeStyle = e.stroke; ctx.lineWidth = e.strokeWidth; ctx.lineCap = 'round'; ctx.stroke();
      break;
    case 'text': {
      ctx.font = fontFor(e); ctx.fillStyle = e.color; ctx.textBaseline = 'top';
      ctx.textAlign = e.align;
      const lines = wrapText(e.text, e.w, s => ctx.measureText(s).width);
      const step = e.size * e.lineHeight, ax = e.align === 'left' ? e.x : e.align === 'right' ? e.x + e.w : e.x + e.w / 2;
      lines.forEach((line, i) => ctx.fillText(line, ax, e.y + i * step + (step - e.size) / 2));
      break;
    }
    case 'image': {
      const img = images.get(e.imageId);
      if (!img || !img.width || !img.height) { ctx.fillStyle = '#E6E8EC'; ctx.fillRect(e.x, e.y, e.w, e.h); break; }
      const box = e.w / e.h, pic = img.width / img.height;
      if (e.fit === 'cover') {
        // Crop the photo to the box's shape, centred.
        let sw = img.width, sh = img.height;
        if (pic > box) sw = img.height * box; else sh = img.width / box;
        ctx.save(); ctx.beginPath(); ctx.rect(e.x, e.y, e.w, e.h); ctx.clip();
        ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, e.x, e.y, e.w, e.h);
        ctx.restore();
      } else {
        let dw = e.w, dh = e.h;
        if (pic > box) dh = e.w / pic; else dw = e.h * pic;
        ctx.drawImage(img, e.x + (e.w - dw) / 2, e.y + (e.h - dh) / 2, dw, dh);
      }
      break;
    }
    case 'qr': {
      // Square, centred in the box, with the quiet zone inside the square.
      const side = Math.min(e.w, e.h), ox = e.x + (e.w - side) / 2, oy = e.y + (e.h - side) / 2;
      if (e.background) { ctx.fillStyle = e.background; ctx.fillRect(ox, oy, side, side); }
      const rows = qrModules(e.data);
      if (!rows) break;
      const unit = side / (rows.length + 2 * QR_QUIET);
      ctx.fillStyle = e.color;
      rows.forEach((row, y) => row.forEach((dark, x) => {
        // A hair of overlap so neighbouring modules never show a seam.
        if (dark) ctx.fillRect(ox + (x + QR_QUIET) * unit, oy + (y + QR_QUIET) * unit, unit + 0.02, unit + 0.02);
      }));
      break;
    }
  }
  ctx.restore();
}

function fillStroke(ctx: Ctx, fill: string | null, stroke: string | null, width: number): void {
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke && width > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
}

/** Pixels per design unit for a download: print at 300 dpi, screen at 1x, never past 8,000 pixels on the long side. */
export function exportScale(size: CreativeDesignSize): number {
  const wanted = size.medium === 'PRINT' ? 300 / 72 : 1;
  return Math.min(wanted, 8000 / Math.max(size.width, size.height));
}
