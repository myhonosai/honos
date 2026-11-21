'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CREATIVE_DESIGN_FONTS, CREATIVE_DESIGN_LIMITS, creativeDesignPhotoIds,
  type CreativeDesign, type CreativeDesignElement, type CreativeDesignPhotoReceipt, type CreativeDesignReceipt, type AddCreativeDesignPhotoInput,
  type CreativeDesignPhoto, type SaveCreativeDesignInput, type SetCreativeDesignStatusInput,
} from '@hon/contracts';
import {
  addElement, commit, duplicateElement, findElement, hitTest, moveLayer, newElement, newElementId, newPhotoElement, normalizeColor, preview, record,
  redo, removeElement, resizeFrom, dragTo, setBackground, sizeOf, startHistory, undo, updateElement, boxOf,
  type AddKind, type Handle, type History, type LayerMove,
} from './model';
import { exportScale, paintPage, type PhotoSource } from './paint';
import { DesignSaver, type SaveState } from './saver';
import { decodePhoto, preparePhoto } from './photos';
import { DesignsAccessError, DesignsRefusal, DesignsUnknown, type DesignsScope } from './http';
import { FONT_NAMES, designText, sizeMeasure, sizeName, type DesignKey } from './copy';
import s from './design-editor.module.css';

export type EditorApi = Readonly<{
  save: (scope: DesignsScope, input: SaveCreativeDesignInput, key: string) => Promise<CreativeDesignReceipt>;
  setStatus: (scope: DesignsScope, input: SetCreativeDesignStatusInput, key: string) => Promise<CreativeDesignReceipt>;
  addPhoto: (scope: DesignsScope, input: AddCreativeDesignPhotoInput, key: string) => Promise<CreativeDesignPhotoReceipt>;
  photo: (scope: DesignsScope, photoId: string, signal?: AbortSignal) => Promise<CreativeDesignPhoto>;
}>;

type Drag = { mode: 'move' | 'resize'; handle: Handle | null; id: string; start: CreativeDesignElement; x: number; y: number; before: History['present']; pointer: number };
type Notice = { key: DesignKey; tone: 'warn' | 'info' } | null;

/** Plain words for the save line under the toolbar. */
export function saveStateText(language: string, state: SaveState): { text: string; tone: 'ok' | 'warn' | 'info' } {
  const t = (key: DesignKey) => designText(language, key);
  switch (state.kind) {
    case 'SAVED': return { text: t('saved'), tone: 'ok' };
    case 'SAVING': return { text: t('saving'), tone: 'info' };
    case 'DIRTY': return { text: t('unsaved'), tone: 'info' };
    case 'UNKNOWN': return { text: t('saveUnknown'), tone: 'warn' };
    case 'NAME': return { text: t('unsaved'), tone: 'warn' };
    case 'CONFLICT': return { text: t('conflict'), tone: 'warn' };
    case 'ARCHIVED': return { text: t('archivedNote'), tone: 'warn' };
    case 'READ_ONLY': return { text: t('readOnly'), tone: 'warn' };
    case 'SESSION': return { text: t('session'), tone: 'warn' };
    case 'REFUSED': return { text: t(state.code === 'CREATIVE_DESIGN_NAME_TAKEN' ? 'refusedName' : state.code === 'CREATIVE_DESIGN_LIMIT' ? 'refusedLimit' : 'refusedOther'), tone: 'warn' };
  }
}

/** The label a layer row shows: its kind, and the start of its words for text. */
export function layerLabel(language: string, e: CreativeDesignElement): string {
  const kind = designText(language, ({ text: 'kindText', rect: 'kindRect', ellipse: 'kindEllipse', line: 'kindLine', image: 'kindImage' } as const)[e.kind]);
  if (e.kind !== 'text') return kind;
  const words = e.text.replace(/\s+/g, ' ').trim();
  return words ? `${kind}: ${words.length > 28 ? words.slice(0, 27) + '…' : words}` : kind;
}

/** A file name for a download: the design name in plain letters, then the side. */
export function downloadName(name: string, side: string): string {
  const slug = name.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase() || 'design';
  return `${slug}${side ? '-' + side : ''}.png`;
}

/**
 * The canvas editor for one saved design. Everything drawn on screen and in a download comes from paint.ts. Edits go
 * through the undo history and are saved by DesignSaver; nothing here prints, sends or publishes.
 */
export function DesignEditor({ scope, design: initial, language, api, onBack, onReload, onChanged }: {
  scope: DesignsScope; design: CreativeDesign; language: string; api: EditorApi; onBack: () => void; onReload: () => void; onChanged?: (design: CreativeDesign) => void;
}): React.ReactElement {
  const t = useCallback((key: DesignKey, vars?: Record<string, string>) => designText(language, key, vars), [language]);
  const size = sizeOf(initial.sizeCode);
  const [design, setDesign] = useState(initial);
  const [history, setHistory] = useState<History>(() => startHistory(initial.document));
  const [name, setName] = useState(initial.name);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'SAVED' });
  const [notice, setNotice] = useState<Notice>(null);
  const [photos, setPhotos] = useState<ReadonlyMap<string, PhotoSource>>(new Map());
  const [busy, setBusy] = useState<'PHOTO' | 'STATUS' | null>(null);
  const [scale, setScale] = useState(0.5);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const requested = useRef(new Set<string>());
  const statusKey = useRef<{ status: string; key: string } | null>(null);
  const saver = useRef<DesignSaver | null>(null);

  const doc = history.present;
  const page = doc.pages[pageIndex] ?? doc.pages[0]!;
  const element = findElement(doc, pageIndex, selected);
  const stopped = saveState.kind === 'CONFLICT' || saveState.kind === 'SESSION' || saveState.kind === 'READ_ONLY' || saveState.kind === 'ARCHIVED';
  const editable = design.status === 'ACTIVE' && !stopped;

  // One saver per opened design version line; it is replaced only when the editor is reopened.
  useEffect(() => {
    const s = new DesignSaver(initial, { save: (input, key) => api.save(scope, input, key), onState: setSaveState,
      onSaved: d => { setDesign(prev => ({ ...prev, ...d })); onChanged?.(d); } });
    saver.current = s;
    const warn = (event: BeforeUnloadEvent) => { if (s.unsaved) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); s.dispose(); if (saver.current === s) saver.current = null; };
  }, [initial.designId, initial.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (editable) saver.current?.change(name, doc); }, [doc, name]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fit the page into the space available.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const fit = () => {
      const width = Math.max(200, wrap.clientWidth - 32), height = Math.max(260, window.innerHeight * 0.72);
      setScale(Math.min(width / size.width, height / size.height));
    };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(wrap);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [size.width, size.height]);

  // Load each photo the document places, once.
  useEffect(() => {
    const abort = new AbortController();
    for (const photoId of creativeDesignPhotoIds(doc)) {
      if (requested.current.has(photoId)) continue;
      requested.current.add(photoId);
      api.photo(scope, photoId, abort.signal).then(p => decodePhoto(p.mediaType, p.data)).then(
        bitmap => setPhotos(prev => new Map(prev).set(photoId, bitmap)),
        () => { requested.current.delete(photoId); });
    }
    return () => abort.abort();
  }, [doc, api, scope]);

  // Paint.
  useEffect(() => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * scale * ratio); canvas.height = Math.round(size.height * scale * ratio);
    paintPage(ctx, page, size, scale * ratio, photos);
  }, [page, size, scale, photos]);

  const edit = useCallback((fn: (d: History['present']) => History['present'], mergeKey: string | null = null) => {
    if (!editable) return;
    setHistory(h => record(h, fn(h.present), mergeKey));
  }, [editable]);
  const patch = (field: string, value: Partial<CreativeDesignElement>) => {
    if (element) edit(d => updateElement(d, pageIndex, initial.sizeCode, element.id, value), `${element.id}:${field}`);
  };

  const add = (kind: AddKind) => {
    if (page.elements.length >= CREATIVE_DESIGN_LIMITS.elementsPerPage) { setNotice({ key: 'elementLimit', tone: 'warn' }); return; }
    const id = newElementId(doc);
    edit(d => addElement(d, pageIndex, newElement(kind, initial.sizeCode, id, t('text'))));
    setSelected(id);
  };
  const layer = (move: LayerMove) => { if (element) edit(d => moveLayer(d, pageIndex, element.id, move)); };
  const remove = () => { if (element) { edit(d => removeElement(d, pageIndex, element.id)); setSelected(null); } };
  const duplicate = () => {
    if (!element) return;
    if (page.elements.length >= CREATIVE_DESIGN_LIMITS.elementsPerPage) { setNotice({ key: 'elementLimit', tone: 'warn' }); return; }
    const id = newElementId(doc);
    edit(d => duplicateElement(d, pageIndex, initial.sizeCode, element.id, id));
    setSelected(id);
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file || !editable || busy) return;
    if (page.elements.length >= CREATIVE_DESIGN_LIMITS.elementsPerPage) { setNotice({ key: 'elementLimit', tone: 'warn' }); return; }
    setBusy('PHOTO'); setNotice({ key: 'photoUploading', tone: 'info' });
    try {
      const bitmap = await createImageBitmap(file);
      const prepared = await preparePhoto(bitmap, file.type);
      if (!prepared) throw new DesignsRefusal('CREATIVE_DESIGN_PHOTO_REFUSED');
      const input = { mediaType: prepared.mediaType, data: prepared.data }, key = crypto.randomUUID();
      let receipt: CreativeDesignPhotoReceipt;
      try { receipt = await api.addPhoto(scope, input, key); }
      catch (error) { if (!(error instanceof DesignsUnknown)) throw error; receipt = await api.addPhoto(scope, input, key); } // one replay, same key
      const decoded = await decodePhoto(prepared.mediaType, prepared.data);
      requested.current.add(receipt.photo.photoId);
      setPhotos(prev => new Map(prev).set(receipt.photo.photoId, decoded));
      const id = newElementId(doc);
      edit(d => addElement(d, pageIndex, newPhotoElement(initial.sizeCode, id, receipt.photo.photoId, prepared.width, prepared.height)));
      setSelected(id); setNotice(null);
    } catch (error) {
      setNotice({ key: error instanceof DesignsRefusal && error.code === 'CREATIVE_DESIGN_PHOTO_LIMIT' ? 'photoLimit'
        : error instanceof DesignsAccessError ? (error.reason === 'SESSION' ? 'session' : 'readOnly') : 'photoFailed', tone: 'warn' });
    } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  };

  const changeStatus = async (status: 'ACTIVE' | 'ARCHIVED') => {
    if (busy) return;
    if (statusKey.current?.status !== status) statusKey.current = { status, key: crypto.randomUUID() };
    setBusy('STATUS');
    try {
      const receipt = await api.setStatus(scope, { designId: design.designId, expectedVersion: saver.current?.savedVersion ?? design.version, status }, statusKey.current.key);
      statusKey.current = null; onChanged?.(receipt.design); onReload();
    } catch (error) {
      if (!(error instanceof DesignsUnknown)) statusKey.current = null;
      setNotice({ key: error instanceof DesignsUnknown ? 'saveUnknown' : error instanceof DesignsRefusal && error.code === 'VERSION_CONFLICT' ? 'conflict' : 'refusedOther', tone: 'warn' });
    } finally { setBusy(null); }
  };

  const download = async () => {
    const k = exportScale(size), canvas = document.createElement('canvas');
    canvas.width = Math.round(size.width * k); canvas.height = Math.round(size.height * k);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    paintPage(ctx, page, size, k, photos);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = downloadName(name, size.sides > 1 ? (pageIndex === 0 ? 'front' : 'back') : '');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  // Pointer: select, move and resize. Coordinates are converted to design units.
  const toDesign = (event: React.PointerEvent) => {
    const rect = (event.currentTarget.closest(`.${s.stage}`) ?? event.currentTarget).getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  const begin = (event: React.PointerEvent, target: CreativeDesignElement, mode: Drag['mode'], handle: Handle | null) => {
    const p = toDesign(event);
    drag.current = { mode, handle, id: target.id, start: target, x: p.x, y: p.y, before: doc, pointer: event.pointerId };
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
  };
  const onStageDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLDivElement).focus();
    const p = toDesign(event), hit = hitTest(page, p.x, p.y, 6 / scale);
    setSelected(hit?.id ?? null);
    if (hit && editable) begin(event, hit, 'move', null);
  };
  const onHandleDown = (handle: Handle) => (event: React.PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    if (element && editable && !element.locked) begin(event, element, 'resize', handle);
  };
  const onMove = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    const p = toDesign(event), dx = p.x - d.x, dy = p.y - d.y;
    const next = d.mode === 'move' ? dragTo(d.start, dx, dy, initial.sizeCode) : resizeFrom(d.start, d.handle!, dx, dy, initial.sizeCode, event.shiftKey);
    setHistory(h => preview(h, updateElement(h.present, pageIndex, initial.sizeCode, d.id, next)));
  };
  const onUp = (event: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointer !== event.pointerId) return;
    drag.current = null;
    setHistory(h => commit(h, d.before));
  };

  const onKey = (event: React.KeyboardEvent) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); setHistory(h => event.shiftKey ? redo(h) : undo(h)); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); setHistory(redo); return; }
    if (event.key === 'Escape') { setSelected(null); return; }
    if (!element || !editable) return;
    if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); return; }
    const step = (event.shiftKey ? 10 : 1) * (size.medium === 'PRINT' ? 1 : 2);
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const m = moves[event.key];
    if (m && !element.locked) { event.preventDefault(); patch('nudge', { x: element.x + m[0], y: element.y + m[1] }); }
  };

  const status = saveStateText(language, design.status === 'ARCHIVED' ? { kind: 'ARCHIVED' } : saveState);
  const box = element ? boxOf(element) : null;
  const handles: { h: Handle; x: number; y: number }[] = !element || element.locked || !editable ? []
    : element.kind === 'line' ? [{ h: 'start', x: element.x, y: element.y }, { h: 'end', x: element.x + element.w, y: element.y + element.h }]
      : [{ h: 'nw', x: element.x, y: element.y }, { h: 'ne', x: element.x + element.w, y: element.y }, { h: 'sw', x: element.x, y: element.y + element.h }, { h: 'se', x: element.x + element.w, y: element.y + element.h }];
  const layers = useMemo(() => [...page.elements].reverse(), [page.elements]);

  return (
    <div className={s.editorRoot}>
      <div className={s.toolbar}>
        <button type="button" className={s.secondary} onClick={() => { saver.current?.flush(); onBack(); }}>{t('back')}</button>
        <label className={`${s.field} ${s.nameInput}`}>
          <span className={s.srOnly}>{t('newName')}</span>
          <input name="designName" value={name} maxLength={CREATIVE_DESIGN_LIMITS.name} disabled={!editable} aria-invalid={saveState.kind === 'NAME' || undefined}
            onChange={event => setName(event.target.value)} onBlur={() => saver.current?.flush()} />
        </label>
        <span className={s.status} data-tone={status.tone} role="status" aria-live="polite">{status.text}</span>
        {saveState.kind === 'CONFLICT' ? <button type="button" className={s.secondary} onClick={onReload}>{t('reload')}</button> : null}
        {design.status === 'ARCHIVED'
          ? <button type="button" className={s.button} disabled={busy !== null} onClick={() => void changeStatus('ACTIVE')}>{t('restore')}</button> : null}
      </div>
      <p className={s.meta}>{sizeName(language, initial.sizeCode)}, {sizeMeasure(initial.sizeCode)}. {size.medium === 'PRINT' ? t('units') : t('pixels')}</p>
      <div className={s.toolbar} role="toolbar" aria-label={t('title')}>
        <button type="button" className={s.secondary} disabled={!editable} onClick={() => add('text')}>{t('addText')}</button>
        <button type="button" className={s.secondary} disabled={!editable} onClick={() => add('rect')}>{t('addRect')}</button>
        <button type="button" className={s.secondary} disabled={!editable} onClick={() => add('ellipse')}>{t('addEllipse')}</button>
        <button type="button" className={s.secondary} disabled={!editable} onClick={() => add('line')}>{t('addLine')}</button>
        <button type="button" className={s.secondary} disabled={!editable || busy !== null} onClick={() => fileRef.current?.click()}>{t('addPhoto')}</button>
        <input ref={fileRef} className={s.hiddenInput} type="file" accept="image/jpeg,image/png,image/webp" tabIndex={-1} aria-hidden="true"
          onChange={event => void pickPhoto(event.target.files?.[0])} />
        <span className={s.spacer} />
        <button type="button" className={s.secondary} disabled={!editable || history.past.length === 0} onClick={() => setHistory(undo)}>{t('undo')}</button>
        <button type="button" className={s.secondary} disabled={!editable || history.future.length === 0} onClick={() => setHistory(redo)}>{t('redo')}</button>
        <button type="button" className={s.button} onClick={() => void download()}>{t('download')}</button>
      </div>
      {notice ? <p className={s.notice} data-tone={notice.tone === 'warn' ? 'warn' : undefined} role={notice.tone === 'warn' ? 'alert' : 'status'}>{t(notice.key)}</p> : null}
      {size.sides > 1 ? (
        <div className={s.toolbar}>
          {doc.pages.map((_, i) => (
            <button key={i} type="button" className={s.secondary} aria-pressed={i === pageIndex} onClick={() => { setPageIndex(i); setSelected(null); }}>
              {i === 0 ? t('front') : t('backSide')}
            </button>
          ))}
        </div>
      ) : null}
      <div className={s.editor}>
        <div className={s.stageWrap} ref={wrapRef}>
          <div className={s.stage} tabIndex={0} role="application" aria-label={t('canvasLabel')} style={{ width: size.width * scale, height: size.height * scale }}
            onPointerDown={onStageDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}>
            <canvas ref={canvasRef} style={{ width: size.width * scale, height: size.height * scale }} aria-hidden="true" />
            {box ? <div className={s.selection} data-locked={element?.locked ? 'true' : undefined}
              style={{ left: box.x * scale, top: box.y * scale, width: Math.max(2, box.w * scale), height: Math.max(2, box.h * scale) }} /> : null}
            {handles.map(h => <span key={h.h} className={s.handle} data-handle={h.h} style={{ left: h.x * scale, top: h.y * scale }}
              onPointerDown={onHandleDown(h.h)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />)}
          </div>
        </div>
        <aside className={s.side}>
          {element ? <Properties element={element} language={language} editable={editable} patch={patch} layer={layer} remove={remove} duplicate={duplicate} />
            : (
              <section className={s.panel} aria-label={t('pageSettings')}>
                <h2>{t('pageSettings')}</h2>
                <label className={s.field}>{t('background')}
                  <input type="color" value={page.background.toLowerCase()} disabled={!editable}
                    onChange={event => { const c = normalizeColor(event.target.value); if (c) edit(d => setBackground(d, pageIndex, c), `bg:${pageIndex}`); }} />
                </label>
                <p className={s.meta}>{size.medium === 'PRINT' ? t('printNote', { size: sizeMeasure(initial.sizeCode) }) : t('screenNote', { size: sizeMeasure(initial.sizeCode) })}</p>
              </section>
            )}
          <section className={s.panel} aria-label={t('layers')}>
            <h2>{t('layers')}</h2>
            {layers.length === 0 ? <p className={s.meta}>{t('layersNone')}</p> : (
              <ul className={s.layerList}>
                {layers.map(e => (
                  <li key={e.id}>
                    <button type="button" aria-current={e.id === selected ? 'true' : undefined} onClick={() => setSelected(e.id)}>
                      {layerLabel(language, e)}{e.locked ? ` (${t('locked')})` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function NumberField({ label, value, step = 1, min, max, disabled, onChange }: {
  label: string; value: number; step?: number; min?: number; max?: number; disabled: boolean; onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <label className={s.field}>{label}
      <input type="number" value={Math.round(value * 100) / 100} step={step} min={min} max={max} disabled={disabled}
        onChange={event => { const n = Number(event.target.value); if (event.target.value !== '' && Number.isFinite(n)) onChange(n); }} />
    </label>
  );
}

function ColorField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }): React.ReactElement {
  return (
    <label className={s.field}>{label}
      <input type="color" value={value.toLowerCase()} disabled={disabled} onChange={event => { const c = normalizeColor(event.target.value); if (c) onChange(c); }} />
    </label>
  );
}

/** The panel for the selected item: its own settings first, then place, size and layer order. */
export function Properties({ element: e, language, editable, patch, layer, remove, duplicate }: {
  element: CreativeDesignElement; language: string; editable: boolean;
  patch: (field: string, value: Partial<CreativeDesignElement>) => void; layer: (move: LayerMove) => void; remove: () => void; duplicate: () => void;
}): React.ReactElement {
  const t = (key: DesignKey) => designText(language, key);
  const off = !editable;
  return (
    <section className={s.panel} aria-label={t('properties')}>
      <h2>{t('properties')}: {layerLabel(language, e).split(':')[0]}</h2>
      {e.kind === 'text' ? (
        <>
          <label className={s.field}>{t('text')}
            <textarea name="elementText" value={e.text} maxLength={CREATIVE_DESIGN_LIMITS.text} disabled={off} onChange={event => patch('text', { text: event.target.value })} />
          </label>
          <div className={s.pair}>
            <label className={s.field}>{t('font')}
              <select value={e.font} disabled={off} onChange={event => patch('font', { font: event.target.value as typeof e.font })}>
                {CREATIVE_DESIGN_FONTS.map(f => <option key={f} value={f}>{FONT_NAMES[f]}</option>)}
              </select>
            </label>
            <NumberField label={t('fontSize')} value={e.size} min={4} max={600} disabled={off} onChange={v => patch('size', { size: v })} />
          </div>
          <div className={s.pair}>
            <ColorField label={t('color')} value={e.color} disabled={off} onChange={v => patch('color', { color: v })} />
            <label className={s.field}>{t('align')}
              <select value={e.align} disabled={off} onChange={event => patch('align', { align: event.target.value as typeof e.align })}>
                <option value="left">{t('alignLeft')}</option><option value="center">{t('alignCenter')}</option><option value="right">{t('alignRight')}</option>
              </select>
            </label>
          </div>
          <div className={s.actions}>
            <label className={s.check}><input type="checkbox" checked={e.bold} disabled={off} onChange={event => patch('bold', { bold: event.target.checked })} />{t('bold')}</label>
            <label className={s.check}><input type="checkbox" checked={e.italic} disabled={off} onChange={event => patch('italic', { italic: event.target.checked })} />{t('italic')}</label>
          </div>
          <NumberField label={t('lineHeight')} value={e.lineHeight} step={0.05} min={0.8} max={3} disabled={off} onChange={v => patch('lineHeight', { lineHeight: v })} />
        </>
      ) : null}
      {e.kind === 'rect' || e.kind === 'ellipse' ? (
        <>
          <div className={s.pair}>
            {e.fill ? <ColorField label={t('fill')} value={e.fill} disabled={off} onChange={v => patch('fill', { fill: v })} /> : <span className={s.meta}>{t('noFill')}</span>}
            <label className={s.check}><input type="checkbox" checked={e.fill === null} disabled={off} onChange={event => patch('fillOn', { fill: event.target.checked ? null : '#C8102E' })} />{t('noFill')}</label>
          </div>
          <div className={s.pair}>
            {e.stroke ? <ColorField label={t('stroke')} value={e.stroke} disabled={off} onChange={v => patch('stroke', { stroke: v })} /> : <span className={s.meta}>{t('noStroke')}</span>}
            <label className={s.check}><input type="checkbox" checked={e.stroke === null} disabled={off}
              onChange={event => patch('strokeOn', event.target.checked ? { stroke: null, strokeWidth: 0 } : { stroke: '#111111', strokeWidth: Math.max(1, e.strokeWidth) })} />{t('noStroke')}</label>
          </div>
          {e.stroke ? <NumberField label={t('strokeWidth')} value={e.strokeWidth} min={0} max={200} disabled={off} onChange={v => patch('strokeWidth', { strokeWidth: v })} /> : null}
          {e.kind === 'rect' ? <NumberField label={t('radius')} value={e.radius} min={0} max={2000} disabled={off} onChange={v => patch('radius', { radius: v })} /> : null}
        </>
      ) : null}
      {e.kind === 'line' ? (
        <div className={s.pair}>
          <ColorField label={t('color')} value={e.stroke} disabled={off} onChange={v => patch('stroke', { stroke: v })} />
          <NumberField label={t('lineWidth')} value={e.strokeWidth} min={0.5} max={200} step={0.5} disabled={off} onChange={v => patch('strokeWidth', { strokeWidth: v })} />
        </div>
      ) : null}
      {e.kind === 'image' ? (
        <label className={s.field}>{t('fit')}
          <select value={e.fit} disabled={off} onChange={event => patch('fit', { fit: event.target.value as typeof e.fit })}>
            <option value="cover">{t('fitCover')}</option><option value="contain">{t('fitContain')}</option>
          </select>
        </label>
      ) : null}
      <div className={s.pair}>
        <NumberField label={t('x')} value={e.x} disabled={off || e.locked} onChange={v => patch('x', { x: v })} />
        <NumberField label={t('y')} value={e.y} disabled={off || e.locked} onChange={v => patch('y', { y: v })} />
        <NumberField label={t('w')} value={e.w} disabled={off || e.locked} onChange={v => patch('w', { w: v })} />
        <NumberField label={t('h')} value={e.h} disabled={off || e.locked} onChange={v => patch('h', { h: v })} />
      </div>
      <div className={s.pair}>
        {e.kind === 'line' ? <span /> : <NumberField label={t('rotation')} value={e.rotation} min={-360} max={360} disabled={off || e.locked} onChange={v => patch('rotation', { rotation: v })} />}
        <NumberField label={`${t('opacity')} %`} value={(1 - e.opacity) * 100} min={0} max={100} step={5} disabled={off} onChange={v => patch('opacity', { opacity: 1 - v / 100 })} />
      </div>
      <label className={s.check}><input type="checkbox" checked={e.locked} disabled={off} onChange={event => patch('locked', { locked: event.target.checked })} />{t('locked')}</label>
      <div className={s.actions}>
        <button type="button" className={s.secondary} disabled={off} onClick={() => layer('front')}>{t('toFront')}</button>
        <button type="button" className={s.secondary} disabled={off} onClick={() => layer('forward')}>{t('forward')}</button>
        <button type="button" className={s.secondary} disabled={off} onClick={() => layer('backward')}>{t('backward')}</button>
        <button type="button" className={s.secondary} disabled={off} onClick={() => layer('back')}>{t('toBack')}</button>
      </div>
      <div className={s.actions}>
        <button type="button" className={s.secondary} disabled={off} onClick={duplicate}>{t('duplicate')}</button>
        <button type="button" className={s.secondary} disabled={off} onClick={remove}>{t('remove')}</button>
      </div>
    </section>
  );
}
