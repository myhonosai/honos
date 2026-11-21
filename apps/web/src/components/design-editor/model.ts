import {
  CREATIVE_DESIGN_LIMITS, CREATIVE_DESIGN_SIZES, type CreativeDesignDocument, type CreativeDesignElement, type CreativeDesignFont, type CreativeDesignPage,
  type CreativeDesignSize, type CreativeDesignSizeCode,
} from '@hon/contracts';

/**
 * Design editor D1 (0617) pure model: element defaults, edits, layer order, hit testing and undo/redo history. Every edit
 * returns a new document that still passes validateCreativeDesignDocument; nothing here talks to the server.
 */
export const FONT_STACKS: Readonly<Record<CreativeDesignFont, string>> = {
  SANS: 'Arial, Helvetica, sans-serif',
  SERIF: 'Georgia, "Times New Roman", serif',
  DISPLAY: 'Impact, "Arial Black", "Helvetica Neue", sans-serif',
  ROUNDED: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
  HANDWRITING: '"Comic Sans MS", "Segoe Print", "Bradley Hand", cursive',
  MONO: '"Courier New", Courier, monospace',
};

export type AddKind = 'text' | 'rect' | 'ellipse' | 'line';
type Box = { x: number; y: number; w: number; h: number };
const round = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function sizeOf(code: CreativeDesignSizeCode): CreativeDesignSize { return CREATIVE_DESIGN_SIZES[code]; }

/** A short id not used anywhere in the document. */
export function newElementId(doc: CreativeDesignDocument, random: () => number = Math.random): string {
  const used = new Set(doc.pages.flatMap(p => p.elements.map(e => e.id)));
  for (;;) {
    const id = 'e' + Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
    if (!used.has(id)) return id;
  }
}

/** A new element of the given kind, centred on the page, sized relative to the page. */
export function newElement(kind: AddKind, code: CreativeDesignSizeCode, id: string, text = 'Your text'): CreativeDesignElement {
  const s = sizeOf(code), short = Math.min(s.width, s.height);
  const base = { id, rotation: 0, opacity: 1, locked: false };
  if (kind === 'text') {
    const size = round(short / 12), w = round(s.width * 0.8), h = round(size * 1.3);
    return { ...base, kind, x: round((s.width - w) / 2), y: round((s.height - h) / 2), w, h, text, font: 'SANS', size, bold: true, italic: false,
      color: '#111111', align: 'center', lineHeight: 1.15 };
  }
  if (kind === 'line') {
    const w = round(s.width * 0.6);
    return { ...base, kind, x: round((s.width - w) / 2), y: round(s.height / 2), w, h: 0, stroke: '#111111', strokeWidth: round(Math.max(1, short / 200)) };
  }
  const side = round(short / 3);
  const box = { x: round((s.width - side) / 2), y: round((s.height - side) / 2), w: side, h: side };
  return kind === 'rect' ? { ...base, kind, ...box, fill: '#C8102E', stroke: null, strokeWidth: 0, radius: 0 }
    : { ...base, kind, ...box, fill: '#1F4E9C', stroke: null, strokeWidth: 0 };
}

/** A photo element that fits inside 60% of the page, keeping the photo's own shape. */
export function newPhotoElement(code: CreativeDesignSizeCode, id: string, imageId: string, naturalWidth: number, naturalHeight: number): CreativeDesignElement {
  const s = sizeOf(code), ratio = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 1;
  let w = s.width * 0.6, h = w / ratio;
  if (h > s.height * 0.6) { h = s.height * 0.6; w = h * ratio; }
  return { id, kind: 'image', x: round((s.width - w) / 2), y: round((s.height - h) / 2), w: round(w), h: round(h), rotation: 0, opacity: 1, locked: false, imageId, fit: 'cover' };
}

function mapPage(doc: CreativeDesignDocument, pageIndex: number, fn: (page: CreativeDesignPage) => CreativeDesignPage): CreativeDesignDocument {
  return { v: 1, pages: doc.pages.map((p, i) => i === pageIndex ? fn(p) : p) };
}
export function findElement(doc: CreativeDesignDocument, pageIndex: number, id: string | null): CreativeDesignElement | null {
  return id ? doc.pages[pageIndex]?.elements.find(e => e.id === id) ?? null : null;
}
/** Keeps an element inside the contract's ranges for its page, so a drag or a typed number can never make it unsavable. */
export function clampElement(e: CreativeDesignElement, code: CreativeDesignSizeCode): CreativeDesignElement {
  const s = sizeOf(code);
  const line = e.kind === 'line';
  const out = { ...e,
    x: round(clamp(e.x, -2 * s.width, 3 * s.width)), y: round(clamp(e.y, -2 * s.height, 3 * s.height)),
    w: round(line ? clamp(e.w, -3 * s.width, 3 * s.width) : clamp(e.w, 1, 3 * s.width)),
    h: round(line ? clamp(e.h, -3 * s.height, 3 * s.height) : clamp(e.h, 1, 3 * s.height)),
    rotation: round(clamp(e.rotation, -360, 360)), opacity: round(clamp(e.opacity, 0, 1)) } as CreativeDesignElement;
  if (out.kind === 'text') { out.size = round(clamp(out.size, 4, 600)); out.lineHeight = round(clamp(out.lineHeight, 0.8, 3)); }
  if (out.kind === 'rect') { out.radius = round(clamp(out.radius, 0, 2000)); out.strokeWidth = round(clamp(out.strokeWidth, 0, 200)); }
  if (out.kind === 'ellipse') out.strokeWidth = round(clamp(out.strokeWidth, 0, 200));
  if (out.kind === 'line') out.strokeWidth = round(clamp(out.strokeWidth, 0.5, 200));
  return out;
}

export function addElement(doc: CreativeDesignDocument, pageIndex: number, element: CreativeDesignElement): CreativeDesignDocument {
  if ((doc.pages[pageIndex]?.elements.length ?? CREATIVE_DESIGN_LIMITS.elementsPerPage) >= CREATIVE_DESIGN_LIMITS.elementsPerPage) return doc;
  return mapPage(doc, pageIndex, p => ({ ...p, elements: [...p.elements, element] }));
}
export function updateElement(doc: CreativeDesignDocument, pageIndex: number, code: CreativeDesignSizeCode, id: string, patch: Partial<CreativeDesignElement>): CreativeDesignDocument {
  return mapPage(doc, pageIndex, p => ({ ...p, elements: p.elements.map(e => e.id === id ? clampElement({ ...e, ...patch, id: e.id, kind: e.kind } as CreativeDesignElement, code) : e) }));
}
export function removeElement(doc: CreativeDesignDocument, pageIndex: number, id: string): CreativeDesignDocument {
  return mapPage(doc, pageIndex, p => ({ ...p, elements: p.elements.filter(e => e.id !== id) }));
}
export function duplicateElement(doc: CreativeDesignDocument, pageIndex: number, code: CreativeDesignSizeCode, id: string, newId: string): CreativeDesignDocument {
  const e = findElement(doc, pageIndex, id);
  if (!e) return doc;
  const offset = Math.min(sizeOf(code).width, sizeOf(code).height) / 40;
  return addElement(doc, pageIndex, clampElement({ ...e, id: newId, x: e.x + offset, y: e.y + offset, locked: false }, code));
}
export type LayerMove = 'forward' | 'backward' | 'front' | 'back';
export function moveLayer(doc: CreativeDesignDocument, pageIndex: number, id: string, move: LayerMove): CreativeDesignDocument {
  return mapPage(doc, pageIndex, p => {
    const list = [...p.elements], from = list.findIndex(e => e.id === id);
    if (from < 0) return p;
    const to = move === 'front' ? list.length - 1 : move === 'back' ? 0 : clamp(from + (move === 'forward' ? 1 : -1), 0, list.length - 1);
    const [item] = list.splice(from, 1);
    list.splice(to, 0, item!);
    return { ...p, elements: list };
  });
}
export function setBackground(doc: CreativeDesignDocument, pageIndex: number, color: string): CreativeDesignDocument {
  return mapPage(doc, pageIndex, p => ({ ...p, background: color }));
}

/** The element's box with positive width and height (a line's box spans its two ends). */
export function boxOf(e: CreativeDesignElement): Box {
  return { x: Math.min(e.x, e.x + e.w), y: Math.min(e.y, e.y + e.h), w: Math.abs(e.w), h: Math.abs(e.h) };
}
/** The topmost unlocked element under the point (rotation is ignored; thin lines get a grab margin). */
export function hitTest(page: CreativeDesignPage, x: number, y: number, margin: number): CreativeDesignElement | null {
  for (let i = page.elements.length - 1; i >= 0; i--) {
    const e = page.elements[i]!;
    if (e.locked) continue;
    const b = boxOf(e), m = e.kind === 'line' ? Math.max(margin, e.strokeWidth) : 0;
    if (x >= b.x - m && x <= b.x + b.w + m && y >= b.y - m && y <= b.y + b.h + m) return e;
  }
  return null;
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'start' | 'end';
/** Drag an element by (dx, dy) from where it started. */
export function dragTo(start: CreativeDesignElement, dx: number, dy: number, code: CreativeDesignSizeCode): CreativeDesignElement {
  return clampElement({ ...start, x: start.x + dx, y: start.y + dy }, code);
}
/** Resize from a corner handle (or move a line end) by (dx, dy) from where it started. keepRatio holds the shape (Shift). */
export function resizeFrom(start: CreativeDesignElement, handle: Handle, dx: number, dy: number, code: CreativeDesignSizeCode, keepRatio = false): CreativeDesignElement {
  if (start.kind === 'line') {
    if (handle === 'start') return clampElement({ ...start, x: start.x + dx, y: start.y + dy, w: start.w - dx, h: start.h - dy }, code);
    return clampElement({ ...start, w: start.w + dx, h: start.h + dy }, code);
  }
  let { x, y, w, h } = start;
  const west = handle === 'nw' || handle === 'sw', north = handle === 'nw' || handle === 'ne';
  let nw = west ? w - dx : w + dx, nh = north ? h - dy : h + dy;
  if (keepRatio && w > 0 && h > 0) { const k = Math.max(nw / w, nh / h); nw = w * k; nh = h * k; }
  nw = Math.max(1, nw); nh = Math.max(1, nh);
  if (west) x = x + w - nw;
  if (north) y = y + h - nh;
  return clampElement({ ...start, x, y, w: nw, h: nh }, code);
}

/** Undo/redo history. A merge key folds a run of edits of the same field (typing, a colour drag) into one undo step. */
export type History = Readonly<{ present: CreativeDesignDocument; past: readonly CreativeDesignDocument[]; future: readonly CreativeDesignDocument[]; mergeKey: string | null }>;
const HISTORY_LIMIT = 100;
export function startHistory(doc: CreativeDesignDocument): History { return { present: doc, past: [], future: [], mergeKey: null }; }
export function record(h: History, next: CreativeDesignDocument, mergeKey: string | null = null): History {
  if (next === h.present) return h;
  if (mergeKey && mergeKey === h.mergeKey) return { ...h, present: next };
  return { present: next, past: [...h.past, h.present].slice(-HISTORY_LIMIT), future: [], mergeKey };
}
/** Replace the present without a history step (live preview during a drag); commit() then records the drag once. */
export function preview(h: History, next: CreativeDesignDocument): History { return { ...h, present: next }; }
export function commit(h: History, before: CreativeDesignDocument): History {
  if (before === h.present) return h;
  return { present: h.present, past: [...h.past, before].slice(-HISTORY_LIMIT), future: [], mergeKey: null };
}
export function undo(h: History): History {
  const prev = h.past[h.past.length - 1];
  return prev ? { present: prev, past: h.past.slice(0, -1), future: [h.present, ...h.future], mergeKey: null } : h;
}
export function redo(h: History): History {
  const next = h.future[0];
  return next ? { present: next, past: [...h.past, h.present], future: h.future.slice(1), mergeKey: null } : h;
}

/** #RRGGBB as the contract wants it (the colour input gives lower case). */
export function normalizeColor(value: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : null;
}
/** Text lines that fit width, split on new lines and then on spaces; one long word stays on its own line. */
export function wrapText(text: string, width: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (line && measure(candidate) > width) { out.push(line); line = word; } else line = candidate;
    }
    out.push(line);
  }
  return out;
}
