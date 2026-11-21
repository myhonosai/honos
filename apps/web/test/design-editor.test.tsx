import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREATIVE_DESIGN_LIMITS, CREATIVE_DESIGN_SIZE_CODES, blankCreativeDesignDocument, validateCreativeDesignDocument,
  type CreativeDesign, type CreativeDesignDocument, type CreativeDesignElement, type CreativeDesignReceipt,
} from '@hon/contracts';

vi.mock('../src/components/localization/provider', () => ({ useLocale: () => ({ preferences: { language: 'en' } }) }));
vi.mock('../src/components/school-shell/context', () => ({
  useSchoolShell: () => ({ phase: 'READY', selection: { organizationId: '11111111-1111-4111-8111-111111111111', schoolId: '22222222-2222-4222-8222-222222222222' } }),
}));

import {
  addElement, clampElement, commit, dragTo, duplicateElement, hitTest, moveLayer, newElement, newElementId, newPhotoElement, normalizeColor, preview, record,
  redo, removeElement, resizeFrom, startHistory, undo, updateElement, wrapText,
} from '../src/components/design-editor/model';
import { DesignSaver, type SaveState } from '../src/components/design-editor/saver';
import { bytesToBase64, base64ToBytes, fitWithin, outputType, preparePhoto } from '../src/components/design-editor/photos';
import { DesignsAccessError, DesignsRefusal, DesignsUnknown, addDesignPhoto, loadDesign, loadDesigns, saveDesign, setDesignStatus } from '../src/components/design-editor/http';
import { designText, sizeName, type DesignKey } from '../src/components/design-editor/copy';
import { Properties, downloadName, layerLabel, saveStateText } from '../src/components/design-editor/editor';
import { Designs, createInput, refusalKey } from '../src/components/design-editor/designs';
import { exportScale, paintPage } from '../src/components/design-editor/paint';
import { SCHOOL_SHELL_NAV } from '../src/components/school-shell/catalog';
import { TEMPLATE_IDS, templateDocument } from '../src/components/design-editor/templates';
import { PRINT_BLEED, PRINT_MARGIN, buildPrintPdf, printBoxes, trimMarks } from '../src/components/design-editor/pdf';
import { shellText } from '../src/components/school-shell/copy';

const id = (n: string) => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const scope = { organizationId: id('1'), schoolId: id('2') };
const base = `/api/v1/organizations/${scope.organizationId}/schools/${scope.schoolId}/creative-studio/designs`;
const ok = (data: unknown, replayed = false) => Response.json({ data, meta: { requestId: id('8'), correlationId: id('8'), replayed } }, { status: 200 });
const problem = (status: number, code?: string) => Response.json(code ? { code, detail: 'x' } : { message: 'x' }, { status });
const at = '2026-11-21T10:00:00.000Z';
const designRow = (over: Partial<CreativeDesign> = {}): CreativeDesign => ({ designId: id('d'), name: 'Spring open house', sizeCode: 'FLYER_LETTER', status: 'ACTIVE', version: 1,
  createdAt: at, updatedAt: at, document: blankCreativeDesignDocument('FLYER_LETTER'), ...over });
const valid = (doc: CreativeDesignDocument, code: Parameters<typeof validateCreativeDesignDocument>[1] = 'FLYER_LETTER') => validateCreativeDesignDocument(doc, code);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('design model (D1, 0617)', () => {
  it('makes new items of every kind that the contract accepts, centred on every size', () => {
    for (const code of CREATIVE_DESIGN_SIZE_CODES) {
      let doc = blankCreativeDesignDocument(code);
      for (const kind of ['text', 'rect', 'ellipse', 'line'] as const) doc = addElement(doc, 0, newElement(kind, code, newElementId(doc)));
      doc = addElement(doc, 0, newPhotoElement(code, newElementId(doc), id('f'), 4000, 3000));
      expect(() => valid(doc, code)).not.toThrow();
      expect(doc.pages[0]!.elements).toHaveLength(5);
    }
  });

  it('keeps every edit inside the contract ranges, whatever was dragged or typed', () => {
    const e = newElement('rect', 'SOCIAL_SQUARE', 'e1');
    const wild = clampElement({ ...e, x: 1e9, y: -1e9, w: -5, h: 1e9, rotation: 999, opacity: 7 } as CreativeDesignElement, 'SOCIAL_SQUARE');
    const doc = addElement(blankCreativeDesignDocument('SOCIAL_SQUARE'), 0, wild);
    expect(() => valid(doc, 'SOCIAL_SQUARE')).not.toThrow();
    expect(wild).toMatchObject({ x: 3240, y: -2160, w: 1, h: 3240, rotation: 360, opacity: 1 });
    const line = clampElement({ ...newElement('line', 'SOCIAL_SQUARE', 'l1'), w: -500, h: -20 } as CreativeDesignElement, 'SOCIAL_SQUARE');
    expect(line).toMatchObject({ w: -500, h: -20 });
  });

  it('stops at 150 items a page and gives ids that are never reused', () => {
    let doc = blankCreativeDesignDocument('FLYER_HALF');
    for (let i = 0; i < CREATIVE_DESIGN_LIMITS.elementsPerPage + 5; i++) doc = addElement(doc, 0, newElement('rect', 'FLYER_HALF', newElementId(doc)));
    expect(doc.pages[0]!.elements).toHaveLength(CREATIVE_DESIGN_LIMITS.elementsPerPage);
    expect(new Set(doc.pages[0]!.elements.map(e => e.id)).size).toBe(CREATIVE_DESIGN_LIMITS.elementsPerPage);
    expect(() => valid(doc, 'FLYER_HALF')).not.toThrow();
  });

  it('updates, duplicates, removes and reorders items', () => {
    let doc = blankCreativeDesignDocument('POSTCARD_4X6');
    doc = addElement(doc, 1, newElement('text', 'POSTCARD_4X6', 'a'));
    doc = addElement(doc, 1, newElement('rect', 'POSTCARD_4X6', 'b'));
    doc = updateElement(doc, 1, 'POSTCARD_4X6', 'a', { text: 'Free trial week', id: 'zz', kind: 'rect' } as Partial<CreativeDesignElement>);
    expect(doc.pages[1]!.elements[0]).toMatchObject({ id: 'a', kind: 'text', text: 'Free trial week' });
    doc = duplicateElement(doc, 1, 'POSTCARD_4X6', 'a', 'c');
    expect(doc.pages[1]!.elements.map(e => e.id)).toEqual(['a', 'b', 'c']);
    doc = moveLayer(doc, 1, 'c', 'back');
    expect(doc.pages[1]!.elements.map(e => e.id)).toEqual(['c', 'a', 'b']);
    doc = moveLayer(doc, 1, 'c', 'forward');
    expect(doc.pages[1]!.elements.map(e => e.id)).toEqual(['a', 'c', 'b']);
    doc = removeElement(doc, 1, 'b');
    expect(doc.pages[1]!.elements.map(e => e.id)).toEqual(['a', 'c']);
    expect(doc.pages[0]!.elements).toEqual([]);
    expect(() => valid(doc, 'POSTCARD_4X6')).not.toThrow();
  });

  it('picks the topmost unlocked item under the pointer, with a grab margin for lines', () => {
    let doc = blankCreativeDesignDocument('SOCIAL_SQUARE');
    const under = { ...newElement('rect', 'SOCIAL_SQUARE', 'under'), x: 0, y: 0, w: 500, h: 500 } as CreativeDesignElement;
    const top = { ...newElement('rect', 'SOCIAL_SQUARE', 'top'), x: 100, y: 100, w: 100, h: 100, locked: true } as CreativeDesignElement;
    const line = { ...newElement('line', 'SOCIAL_SQUARE', 'line'), x: 600, y: 600, w: 200, h: 0, strokeWidth: 2 } as CreativeDesignElement;
    doc = [under, top, line].reduce((d, e) => addElement(d, 0, e), doc);
    expect(hitTest(doc.pages[0]!, 150, 150, 4)?.id).toBe('under');
    expect(hitTest(doc.pages[0]!, 700, 604, 6)?.id).toBe('line');
    expect(hitTest(doc.pages[0]!, 900, 900, 4)).toBeNull();
  });

  it('moves and resizes from each corner, holds the shape with Shift, and moves either end of a line', () => {
    const box = { ...newElement('rect', 'SOCIAL_SQUARE', 'r'), x: 100, y: 100, w: 200, h: 100 } as CreativeDesignElement;
    expect(dragTo(box, 50, -20, 'SOCIAL_SQUARE')).toMatchObject({ x: 150, y: 80, w: 200, h: 100 });
    expect(resizeFrom(box, 'se', 100, 50, 'SOCIAL_SQUARE')).toMatchObject({ x: 100, y: 100, w: 300, h: 150 });
    expect(resizeFrom(box, 'nw', 50, 50, 'SOCIAL_SQUARE')).toMatchObject({ x: 150, y: 150, w: 150, h: 50 });
    expect(resizeFrom(box, 'nw', 500, 500, 'SOCIAL_SQUARE')).toMatchObject({ w: 1, h: 1, x: 299, y: 199 });
    expect(resizeFrom(box, 'se', 200, 0, 'SOCIAL_SQUARE', true)).toMatchObject({ w: 400, h: 200 });
    const line = { ...newElement('line', 'SOCIAL_SQUARE', 'l'), x: 100, y: 100, w: 200, h: 0 } as CreativeDesignElement;
    expect(resizeFrom(line, 'start', -50, 10, 'SOCIAL_SQUARE')).toMatchObject({ x: 50, y: 110, w: 250, h: -10 });
    expect(resizeFrom(line, 'end', 10, 30, 'SOCIAL_SQUARE')).toMatchObject({ x: 100, y: 100, w: 210, h: 30 });
  });

  it('undoes and redoes, folds typing into one step, and records a drag once', () => {
    const d0 = blankCreativeDesignDocument('FLYER_LETTER');
    const d1 = addElement(d0, 0, newElement('text', 'FLYER_LETTER', 't'));
    let h = record(startHistory(d0), d1);
    h = record(h, updateElement(h.present, 0, 'FLYER_LETTER', 't', { text: 'K' }), 't:text');
    h = record(h, updateElement(h.present, 0, 'FLYER_LETTER', 't', { text: 'Ka' }), 't:text');
    h = record(h, updateElement(h.present, 0, 'FLYER_LETTER', 't', { text: 'Kar' }), 't:text');
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(h.present).toBe(d1);
    h = redo(h);
    expect((h.present.pages[0]!.elements[0] as { text: string }).text).toBe('Kar');
    const before = h.present;
    h = preview(h, updateElement(h.present, 0, 'FLYER_LETTER', 't', { x: 10 }));
    h = preview(h, updateElement(h.present, 0, 'FLYER_LETTER', 't', { x: 20 }));
    h = commit(h, before);
    expect(h.past).toHaveLength(3);
    expect(undo(h).present).toBe(before);
    expect(undo(startHistory(d0)).present).toBe(d0);
  });

  it('normalizes colours and wraps text on spaces and new lines', () => {
    expect(normalizeColor('#c8102e')).toBe('#C8102E');
    expect(normalizeColor('red')).toBeNull();
    expect(wrapText('one two three\nfour', 9, s => s.length)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('supercalifragilistic', 5, s => s.length)).toEqual(['supercalifragilistic']);
  });
});

describe('design painter', () => {
  it('paints the background and each item in layer order, with a placeholder for a photo not loaded yet', () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, prop) => prop === 'measureText' ? (s: string) => ({ width: s.length * 10 }) : prop === 'roundRect' ? (...a: unknown[]) => calls.push(`roundRect:${a.length}`)
      : (...a: unknown[]) => { calls.push(`${String(prop)}${prop === 'fillText' ? ':' + String(a[0]) : ''}`); }, set: () => true }) as unknown as CanvasRenderingContext2D;
    let doc = blankCreativeDesignDocument('SOCIAL_SQUARE');
    doc = addElement(doc, 0, { ...newElement('rect', 'SOCIAL_SQUARE', 'r'), radius: 10 } as CreativeDesignElement);
    doc = addElement(doc, 0, newPhotoElement('SOCIAL_SQUARE', 'p', id('f'), 100, 100));
    doc = addElement(doc, 0, { ...newElement('text', 'SOCIAL_SQUARE', 't'), text: 'Kids karate' } as CreativeDesignElement);
    paintPage(ctx, doc.pages[0]!, { code: 'SOCIAL_SQUARE', medium: 'SCREEN', width: 1080, height: 1080, sides: 1 }, 0.5, new Map());
    expect(calls[0]).toBe('save');
    expect(calls).toContain('fillRect');
    expect(calls.indexOf('roundRect:5')).toBeLessThan(calls.indexOf('fillText:Kids karate'));
    expect(calls.filter(c => c === 'drawImage')).toHaveLength(0);
  });

  it('downloads print at 300 dpi and caps the long side at 8,000 pixels', () => {
    expect(exportScale({ code: 'FLYER_LETTER', medium: 'PRINT', width: 612, height: 792, sides: 1 })).toBeCloseTo(300 / 72);
    expect(Math.round(1728 * exportScale({ code: 'POSTER_18X24', medium: 'PRINT', width: 1296, height: 1728, sides: 1 }))).toBe(7200);
    expect(exportScale({ code: 'SOCIAL_STORY', medium: 'SCREEN', width: 1080, height: 1920, sides: 1 })).toBe(1);
    expect(exportScale({ code: 'SOCIAL_STORY', medium: 'PRINT', width: 4000, height: 6000, sides: 1 }) * 6000).toBeCloseTo(8000);
  });
});

describe('design autosave', () => {
  const receipt = (version: number, doc: CreativeDesignDocument, replayed = false): CreativeDesignReceipt => ({ design: designRow({ version, document: doc }), replayed });
  function setup(save: (input: unknown, key: string) => Promise<CreativeDesignReceipt>) {
    vi.useFakeTimers();
    const states: SaveState['kind'][] = [];
    let n = 0;
    const saver = new DesignSaver(designRow(), { save: save as never, onState: st => states.push(st.kind), newKey: () => `key-${++n}`, delayMs: 1000 });
    return { saver, states };
  }
  const withText = (text: string) => addElement(blankCreativeDesignDocument('FLYER_LETTER'), 0, { ...newElement('text', 'FLYER_LETTER', 't'), text } as CreativeDesignElement);

  it('saves once after the last change, with the version it was based on, then the next edit gets a new key and version', async () => {
    const save = vi.fn(async (input: { expectedVersion: number; document: CreativeDesignDocument }) => receipt(input.expectedVersion + 1, input.document));
    const { saver, states } = setup(save as never);
    saver.change('Spring open house', withText('A'));
    saver.change('Spring open house', withText('AB'));
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([expect.objectContaining({ designId: id('d'), expectedVersion: 1, document: withText('AB') }), 'key-1']);
    saver.change('Spring open house', withText('ABC'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls[1]).toEqual([expect.objectContaining({ expectedVersion: 2 }), 'key-2']);
    expect(states.at(-1)).toBe('SAVED');
    expect(saver.unsaved).toBe(false);
  });

  it('sends an unknown save again with the same key and body, even after newer edits, and only then saves the newer edit', async () => {
    let calls = 0;
    const save = vi.fn(async (input: { expectedVersion: number; document: CreativeDesignDocument }) => {
      if (++calls === 1) throw new DesignsUnknown('network');
      return receipt(input.expectedVersion + 1, input.document, calls === 2);
    });
    const { saver, states } = setup(save as never);
    saver.change('Spring open house', withText('A'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(states).toContain('UNKNOWN');
    saver.change('Spring open house', withText('AB'));
    expect(saver.unsaved).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save.mock.calls[1]).toEqual([expect.objectContaining({ expectedVersion: 1, document: withText('A') }), 'key-1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls[2]).toEqual([expect.objectContaining({ expectedVersion: 2, document: withText('AB') }), 'key-2']);
    expect(states.at(-1)).toBe('SAVED');
  });

  it('stops on a version conflict, a lost session or no permission, and waits for a new edit after a plain refusal', async () => {
    for (const [error, kind] of [[new DesignsRefusal('VERSION_CONFLICT'), 'CONFLICT'], [new DesignsAccessError('SESSION'), 'SESSION'],
      [new DesignsAccessError('FORBIDDEN'), 'READ_ONLY'], [new DesignsRefusal('CREATIVE_DESIGN_ARCHIVED'), 'ARCHIVED']] as const) {
      const save = vi.fn(async () => { throw error; });
      const { saver, states } = setup(save as never);
      saver.change('Spring open house', withText('A'));
      await vi.advanceTimersByTimeAsync(1000);
      saver.change('Spring open house', withText('AB'));
      await vi.advanceTimersByTimeAsync(60000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(states.at(-1)).toBe(kind);
      saver.dispose(); vi.useRealTimers();
    }
    const save = vi.fn(async () => { throw new DesignsRefusal('CREATIVE_DESIGN_NAME_TAKEN'); });
    const { saver, states } = setup(save as never);
    saver.change('Taken', withText('A'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('REFUSED');
    saver.change('Taken 2', withText('A'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect((save.mock.calls[1] as unknown[])[1]).toBe('key-2');
  });

  it('does not send a blank name, and does nothing after it is closed', async () => {
    const save = vi.fn(async (input: { expectedVersion: number; document: CreativeDesignDocument }) => receipt(input.expectedVersion + 1, input.document));
    const { saver, states } = setup(save as never);
    saver.change('   ', withText('A'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('NAME');
    saver.change('Fine', withText('A'));
    saver.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('design photos', () => {
  it('shrinks to 2,400 pixels on the long side, never enlarges, and keeps PNG for transparency', () => {
    expect(fitWithin(6000, 4000)).toEqual({ w: 2400, h: 1600 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(0, 10)).toEqual({ w: 0, h: 0 });
    expect(outputType('image/png')).toBe('image/png');
    expect(outputType('image/heic')).toBe('image/jpeg');
  });

  it('re-encodes smaller until the photo fits, falls back from PNG to JPEG, and gives up when nothing fits', async () => {
    const bytes = (n: number) => new Blob([new Uint8Array(n)]);
    const source = { width: 6000, height: 3000 } as ImageBitmap;
    const seen: string[] = [];
    const encode = vi.fn(async (_s: ImageBitmap, w: number, _h: number, type: string) => { seen.push(`${type}:${w}`); return bytes(type === 'image/png' ? 2_000_000 : w > 1500 ? 1_500_000 : 900_000); });
    const out = await preparePhoto(source, 'image/png', encode);
    expect(out).toMatchObject({ mediaType: 'image/jpeg', width: 1200, height: 600 });
    expect(seen.slice(0, 4).every(s => s.startsWith('image/png'))).toBe(true);
    expect(base64ToBytes(out!.data)).toHaveLength(900_000);
    expect(await preparePhoto(source, 'image/jpeg', async () => bytes(5_000_000))).toBeNull();
    expect(base64ToBytes(bytesToBase64(new Uint8Array([0, 255, 7])))).toEqual(new Uint8Array([0, 255, 7]));
  });
});

describe('design http', () => {
  it('lists, reads and saves over the school path with the human command headers, and checks each answer', async () => {
    const summary = { ...designRow() } as Record<string, unknown>; delete summary.document;
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(ok({ designs: [summary] }))
      .mockResolvedValueOnce(ok(designRow()))
      .mockResolvedValueOnce(ok(designRow({ version: 1 }), true));
    expect((await loadDesigns(scope, { status: 'ACTIVE' })).designs).toHaveLength(1);
    expect((await loadDesign(scope, id('d'))).name).toBe('Spring open house');
    const r = await saveDesign(scope, createInput(' Spring open house ', 'FLYER_LETTER')!, id('9'));
    expect(r.replayed).toBe(true);
    const calls = fetcher.mock.calls.map(c => ({ path: String(c[0]), init: c[1] as RequestInit & { headers: Record<string, string> } }));
    expect(calls.map(c => c.path)).toEqual([`${base}?status=ACTIVE`, `${base}/${id('d')}`, base]);
    expect(calls[2]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
    expect(calls[2]!.init.headers).toMatchObject({ 'X-HON-Human-Command': 'creative.design.save', 'Idempotency-Key': id('9') });
    expect(JSON.parse(String(calls[2]!.init.body))).toMatchObject({ designId: null, expectedVersion: 0, name: 'Spring open house' });
  });

  it('turns answers into access errors, definite refusals and unknown outcomes', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(problem(401)).mockResolvedValueOnce(problem(403)).mockResolvedValueOnce(problem(409, 'VERSION_CONFLICT'))
      .mockResolvedValueOnce(problem(500)).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(ok(designRow({ version: 7 })))
      .mockResolvedValueOnce(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(loadDesigns(scope)).rejects.toMatchObject({ reason: 'SESSION' });
    await expect(loadDesigns(scope)).rejects.toMatchObject({ reason: 'FORBIDDEN' });
    await expect(setDesignStatus(scope, { designId: id('d'), expectedVersion: 1, status: 'ARCHIVED' }, id('9'))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(setDesignStatus(scope, { designId: id('d'), expectedVersion: 1, status: 'ARCHIVED' }, id('9'))).rejects.toBeInstanceOf(DesignsUnknown);
    await expect(addDesignPhoto(scope, { mediaType: 'image/png', data: 'iVBORw0KGgo=' }, id('9'))).rejects.toBeInstanceOf(DesignsUnknown);
    // A receipt for the wrong version is not believed.
    await expect(setDesignStatus(scope, { designId: id('d'), expectedVersion: 1, status: 'ARCHIVED' }, id('9'))).rejects.toBeInstanceOf(DesignsUnknown);
    await expect(loadDesign(scope, id('d'))).rejects.toBeInstanceOf(DesignsUnknown);
    await expect(loadDesign({ ...scope, schoolId: 'nope' }, id('d'))).rejects.toBeInstanceOf(DesignsUnknown);
  });
});

describe('design screens and copy', () => {
  it('has every phrase in English, Korean and Spanish, and a size name for each size', () => {
    for (const language of ['en', 'ko', 'es']) {
      for (const key of ['title', 'saved', 'conflict', 'download', 'printNote'] as DesignKey[]) expect(designText(language, key)).not.toBe('');
      for (const code of CREATIVE_DESIGN_SIZE_CODES) expect(sizeName(language, code)).toBeTruthy();
    }
    expect(designText('ko', 'saved')).toBe('저장됨');
    expect(designText('es-MX', 'printNote', { size: '8.5 × 11 in' })).toContain('8.5 × 11 in');
  });

  it('describes each save state and refusal in plain words', () => {
    expect(saveStateText('en', { kind: 'SAVED' })).toEqual({ text: 'Saved', tone: 'ok' });
    expect(saveStateText('en', { kind: 'REFUSED', code: 'CREATIVE_DESIGN_NAME_TAKEN' }).text).toBe('Another design already has that name.');
    expect(saveStateText('en', { kind: 'UNKNOWN' }).tone).toBe('warn');
    expect(refusalKey(new DesignsRefusal('CREATIVE_DESIGN_LIMIT'))).toBe('refusedLimit');
    expect(refusalKey(new DesignsAccessError('FORBIDDEN'))).toBe('readOnly');
    expect(refusalKey(new DesignsUnknown())).toBe('saveUnknown');
    expect(createInput('   ', 'FLYER_LETTER')).toBeNull();
    expect(createInput(' Kids ', 'POSTCARD_4X6')?.document.pages).toHaveLength(2);
  });

  it('labels layers and download files plainly', () => {
    const text = { ...newElement('text', 'FLYER_LETTER', 't'), text: 'Summer camp\nsign-ups open now for all ages' } as CreativeDesignElement;
    expect(layerLabel('en', text)).toBe('Text: Summer camp sign-ups open n…');
    expect(layerLabel('es', newElement('ellipse', 'FLYER_LETTER', 'c'))).toBe('Círculo');
    expect(downloadName('Spring Open House!', 'front')).toBe('spring-open-house-front.png');
    expect(downloadName('???', '')).toBe('design.png');
  });

  it('shows the settings for the selected item and disables them when the design cannot be changed', () => {
    const noop = () => {};
    const text = renderToStaticMarkup(<Properties element={newElement('text', 'FLYER_LETTER', 't')} language="en" editable patch={noop} layer={noop} remove={noop} duplicate={noop} />);
    expect(text).toContain('Your text');
    expect(text).toContain('Handwriting');
    expect(text).not.toContain('disabled');
    const box = renderToStaticMarkup(<Properties element={{ ...newElement('rect', 'FLYER_LETTER', 'r'), stroke: null } as CreativeDesignElement} language="en" editable={false} patch={noop} layer={noop} remove={noop} duplicate={noop} />);
    expect(box).toContain('Rounded corners');
    expect(box).toContain('No outline');
    expect(box).toContain('disabled');
  });

  it('opens on a loading list for the verified school, and the menu lists the page under Creative Studio', () => {
    const html = renderToStaticMarkup(<Designs api={{ list: vi.fn(), get: vi.fn(), save: vi.fn(), setStatus: vi.fn(), addPhoto: vi.fn(), photo: vi.fn() }} />);
    expect(html).toContain('Designs');
    expect(html).toContain('Loading…');
    const creative = SCHOOL_SHELL_NAV.find(item => item.key === 'creative')!;
    expect(creative.routes.map(r => r.href)).toEqual(['/staff/creative-studio', '/staff/creative-studio/designs']);
    for (const language of ['en', 'ko', 'es']) expect(shellText(language, 'routeDesigns')).toBeTruthy();
  });
});

describe('design D2: QR codes, templates, brand kit and print PDF', () => {
  it('accepts a QR element only with 1-200 printable characters, a colour and an optional background', () => {
    const qr = (o: Record<string, unknown> = {}) => ({ ...newElement('qr', 'FLYER_LETTER', 'q', 'https://example.test/trial'), ...o }) as CreativeDesignElement;
    const docWith = (e: CreativeDesignElement) => addElement(blankCreativeDesignDocument('FLYER_LETTER'), 0, e);
    expect(() => valid(docWith(qr()))).not.toThrow();
    expect(() => valid(docWith(qr({ background: null })))).not.toThrow();
    for (const bad of [{ data: '' }, { data: 'x'.repeat(201) }, { data: 'café' }, { data: 'a\nb' }, { color: null }, { background: 'white' }])
      expect(() => valid(docWith(qr(bad))), JSON.stringify(bad)).toThrow();
  });

  it('encodes QR codes that a reader decodes back to the same text', async () => {
    const z = await import('@zxing/library');
    const { qrModules, QR_QUIET } = await import('../src/components/design-editor/qr');
    for (const data of ['https://example.test/trial?c=spring', 'HON', 'x'.repeat(200)]) {
      const rows = qrModules(data)!;
      const unit = 4, side = (rows.length + 2 * QR_QUIET) * unit, pixels = new Uint8ClampedArray(side * side).fill(255);
      rows.forEach((row, y) => row.forEach((dark, x) => {
        if (!dark) return;
        for (let dy = 0; dy < unit; dy++) for (let dx = 0; dx < unit; dx++) pixels[((y + QR_QUIET) * unit + dy) * side + (x + QR_QUIET) * unit + dx] = 0;
      }));
      const bitmap = new z.BinaryBitmap(new z.HybridBinarizer(new z.RGBLuminanceSource(pixels, side, side)));
      expect(new z.QRCodeReader().decode(bitmap).getText()).toBe(data);
    }
    expect(qrModules('')).toBeNull();
    expect(qrModules('é')).toBeNull();
  });

  it('paints a QR code square in its box on its background, and paints the bleed for print', () => {
    const calls: { op: string; args: unknown[] }[] = [];
    const ctx = new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => { calls.push({ op: String(prop), args }); }, set: () => true }) as unknown as CanvasRenderingContext2D;
    let doc = blankCreativeDesignDocument('FLYER_LETTER');
    doc = addElement(doc, 0, { ...newElement('qr', 'FLYER_LETTER', 'q', 'HON'), x: 100, y: 100, w: 200, h: 100 } as CreativeDesignElement);
    paintPage(ctx, doc.pages[0]!, { code: 'FLYER_LETTER', medium: 'PRINT', width: 612, height: 792, sides: 1 }, 2, new Map(), 9);
    expect(calls.find(c => c.op === 'setTransform')!.args).toEqual([2, 0, 0, 2, 18, 18]);
    const fills = calls.filter(c => c.op === 'fillRect').map(c => c.args as number[]);
    expect(fills[0]).toEqual([-9, -9, 630, 810]);
    expect(fills[1]).toEqual([150, 100, 100, 100]);
    const modules = fills.slice(2);
    expect(modules.length).toBeGreaterThan(100);
    for (const [x, y, w] of modules) { expect(x).toBeGreaterThanOrEqual(150); expect(x! + w!).toBeLessThanOrEqual(250.1); expect(y).toBeGreaterThanOrEqual(100); }
  });

  it('builds every template on every size in every language as a valid document, with the school color and contact line', () => {
    for (const template of [null, ...TEMPLATE_IDS]) for (const code of CREATIVE_DESIGN_SIZE_CODES) for (const language of ['en', 'ko', 'es']) {
      const doc = templateDocument(template, code, language, { accent: '#1F4E9C', contactLine: 'Sunrise Martial Arts · 555-0100' });
      expect(() => valid(doc, code), `${template} ${code} ${language}`).not.toThrow();
    }
    const trial = templateDocument('trial', 'POSTCARD_4X6', 'en', { accent: '#1F4E9C', contactLine: 'Sunrise Martial Arts · 555-0100' });
    expect(trial.pages).toHaveLength(2);
    expect(JSON.stringify(trial)).toContain('Sunrise Martial Arts');
    expect(trial.pages[0]!.elements.find(e => e.id === 'band')).toMatchObject({ fill: '#1F4E9C' });
    const plain = templateDocument('openHouse', 'SOCIAL_SQUARE', 'ko');
    expect(JSON.stringify(plain)).toContain('오픈 하우스');
    expect(JSON.stringify(plain)).toContain('#C8102E');
    expect(templateDocument(null, 'FLYER_HALF', 'en')).toEqual(blankCreativeDesignDocument('FLYER_HALF'));
    expect(createInput('Trial', 'FLYER_LETTER', 'trial', 'es')?.document.pages[0]!.elements.length).toBeGreaterThan(3);
  });

  it('writes a print PDF with one page per side, bleed and trim boxes, trim marks outside the bleed, and a correct cross-reference table', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const size = { width: 432, height: 288 };
    const pdf = buildPrintPdf(size, [{ jpeg, width: 1875, height: 1275 }, { jpeg, width: 1875, height: 1275 }], 'Open (house) é');
    const text = Array.from(pdf, b => String.fromCharCode(b)).join('');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 2');
    const boxes = printBoxes(size), m = PRINT_MARGIN;
    expect(boxes.trim).toEqual([m, m, m + 432, m + 288]);
    expect(boxes.bleed).toEqual([m - PRINT_BLEED, m - PRINT_BLEED, m + 432 + PRINT_BLEED, m + 288 + PRINT_BLEED]);
    expect(text).toContain(`/TrimBox [${m} ${m} ${m + 432} ${m + 288}]`);
    expect(text).toContain('/Filter /DCTDecode /Length 4');
    expect(text).toContain('/Title (Open \\(house\\) ?)');
    // Every mark sits outside the bleed box.
    const marks = trimMarks(size);
    expect(marks).toHaveLength(8);
    const [bx0, by0, bx1, by1] = boxes.bleed;
    for (const [x0, y0, x1, y1] of marks) {
      const outside = (x: number, y: number) => x <= bx0! || x >= bx1! || y <= by0! || y >= by1!;
      expect(outside(x0!, y0!) && outside(x1!, y1!)).toBe(true);
    }
    // The xref offsets point at each object.
    const xrefAt = Number(text.match(/startxref\n(\d+)/)![1]);
    const lines = text.slice(xrefAt).split('\n');
    const count = Number(lines[1]!.split(' ')[1]);
    for (let i = 1; i < count; i++) expect(text.slice(Number(lines[2 + i]!.slice(0, 10)), Number(lines[2 + i]!.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i} 0 obj`));
    // Content streams declare their exact length.
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(text.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe('endstream\n'.slice(0, 10));
    }
  });

  it('shows QR settings and the school color swatch', () => {
    const noop = () => {};
    const html = renderToStaticMarkup(<Properties element={newElement('qr', 'FLYER_LETTER', 'q', 'https://example.test')} language="en" editable patch={noop} layer={noop} remove={noop} duplicate={noop} swatch="#1F4E9C" />);
    expect(html).toContain('Link or text in the code');
    expect(html).toContain('https://example.test');
    expect(html).toContain('aria-label="School color #1F4E9C"');
    expect(layerLabel('ko', newElement('qr', 'FLYER_LETTER', 'q', 'x'))).toBe('QR 코드');
    expect(downloadName('Open house', 'print', 'pdf')).toBe('open-house-print.pdf');
  });
});

describe('design review fixes', () => {
  const withText = (text: string) => addElement(blankCreativeDesignDocument('FLYER_LETTER'), 0, { ...newElement('text', 'FLYER_LETTER', 't'), text } as CreativeDesignElement);
  it('never sends a document the server would refuse, and saves again once it is valid', async () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const save = vi.fn(async (input: { expectedVersion: number; document: CreativeDesignDocument }) => ({ design: designRow({ version: input.expectedVersion + 1, document: input.document }), replayed: false }));
    const saver = new DesignSaver(designRow(), { save: save as never, onState: st => states.push(st.kind), newKey: () => 'k', delayMs: 1000 });
    saver.change('Spring open house', withText(''));
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe('REFUSED');
    saver.change('Spring open house', withText('Back again'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe('SAVED');
  });

  it('saves a waiting change at once when the editor is left', async () => {
    let release!: () => void;
    const save = vi.fn((input: { expectedVersion: number; document: CreativeDesignDocument }) => new Promise<CreativeDesignReceipt>(resolve => {
      release = () => resolve({ design: designRow({ version: input.expectedVersion + 1, document: input.document }), replayed: false }); }));
    const saver = new DesignSaver(designRow(), { save: save as never, onState: () => {}, newKey: () => 'k', delayMs: 60000 });
    saver.change('Spring open house', withText('Last change'));
    let settled = false;
    const done = saver.settle().then(() => { settled = true; });
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    release(); await done;
    expect(saver.unsaved).toBe(false);
  });

  it('refuses the C1 control characters in a name, as the database does', () => {
    expect(createInput('Open\u0085house', 'FLYER_LETTER')).toBeNull();
  });
});
