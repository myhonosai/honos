'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CREATIVE_DESIGN_LIMITS, CREATIVE_DESIGN_SIZE_CODES, blankCreativeDesignDocument, creativeDesignNameOk,
  type CreativeDesign, type CreativeDesignList, type CreativeDesignSizeCode, type CreativeDesignStatus, type CreativeDesignSummary, type CreativeDesignsQuery,
} from '@hon/contracts';
import { useLocale } from '../localization/provider';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import {
  DesignsAccessError, DesignsRefusal, DesignsUnknown, addDesignPhoto, loadDesign, loadDesignPhoto, loadDesigns, saveDesign, setDesignStatus, type DesignsScope,
} from './http';
import { DesignEditor, type EditorApi } from './editor';
import { NO_BRAND, TEMPLATE_IDS, TEMPLATE_NAMES, templateDocument, type Brand, type TemplateId } from './templates';
import { brandingApi } from '../school-branding/http';
import { designText, sizeMeasure, sizeName, type DesignKey } from './copy';
import s from './design-editor.module.css';

export type DesignsApi = EditorApi & Readonly<{
  list: (scope: DesignsScope, query: CreativeDesignsQuery, signal?: AbortSignal) => Promise<CreativeDesignList>;
  get: (scope: DesignsScope, designId: string, signal?: AbortSignal) => Promise<CreativeDesign>;
  /** The school's accent color and contact line, when this person may read branding; otherwise nothing (never an error). */
  brand?: (scope: DesignsScope, signal: AbortSignal, owned: () => boolean) => Promise<Brand>;
}>;
export const DESIGNS_API: DesignsApi = {
  list: loadDesigns, get: loadDesign, save: saveDesign, setStatus: setDesignStatus, addPhoto: addDesignPhoto, photo: loadDesignPhoto,
  brand: async (scope, signal, owned) => {
    const b = await brandingApi.read(scope, signal, owned);
    return { accent: b.accentColor ? b.accentColor.toUpperCase() : null, contactLine: b.contactLine };
  },
};

type Load = 'LOADING' | 'READY' | 'DENIED' | 'SESSION' | 'UNAVAILABLE';
type Open = { state: 'NONE' } | { state: 'LOADING'; designId: string } | { state: 'READY'; design: CreativeDesign } | { state: 'FAILED'; designId: string };
const failure = (error: unknown): Load => error instanceof DesignsAccessError ? (error.reason === 'SESSION' ? 'SESSION' : 'DENIED') : 'UNAVAILABLE';

/** Plain words for a refused create or status change. */
export function refusalKey(error: unknown): DesignKey {
  if (error instanceof DesignsAccessError) return error.reason === 'SESSION' ? 'session' : 'readOnly';
  if (error instanceof DesignsUnknown) return 'saveUnknown';
  if (error instanceof DesignsRefusal) {
    if (error.code === 'CREATIVE_DESIGN_NAME_TAKEN') return 'refusedName';
    if (error.code === 'CREATIVE_DESIGN_LIMIT') return 'refusedLimit';
    if (error.code === 'VERSION_CONFLICT') return 'conflict';
  }
  return 'refusedOther';
}

/** The create command a new design sends: the trimmed name and a blank page per side. Null while the name is not usable. */
export function createInput(name: string, sizeCode: CreativeDesignSizeCode, template: TemplateId | null = null, language = 'en', brand: Brand = NO_BRAND) {
  const trimmed = name.trim();
  if (!creativeDesignNameOk(trimmed)) return null;
  return { designId: null, expectedVersion: 0, name: trimmed, sizeCode,
    document: template ? templateDocument(template, sizeCode, language, brand) : blankCreativeDesignDocument(sizeCode) };
}

/**
 * Creative Studio designs for the school the shell verified. The list and each design are read again from the server;
 * the server re-checks creative.design.read / creative.design.manage for every call. A create or status change whose
 * outcome is unknown keeps its key, so pressing the button again replays it instead of making a second design.
 */
export function Designs({ api = DESIGNS_API }: { api?: DesignsApi }): React.ReactElement {
  const { preferences } = useLocale();
  const language = preferences.language;
  const t = useCallback((key: DesignKey, vars?: Record<string, string>) => designText(language, key, vars), [language]);
  const shell = useSchoolShell();
  const selection = shell.phase === 'READY' ? shell.selection : null;
  // One scope object per school, so the editor's effects do not restart on every render.
  const scope: DesignsScope | null = useMemo(() => selection ? { organizationId: selection.organizationId, schoolId: selection.schoolId } : null,
    [selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [load, setLoad] = useState<Load>('LOADING');
  const [items, setItems] = useState<CreativeDesignSummary[]>([]);
  const [status, setStatus] = useState<CreativeDesignStatus>('ACTIVE');
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState<Open>({ state: 'NONE' });
  const [newName, setNewName] = useState('');
  const [newSize, setNewSize] = useState<CreativeDesignSizeCode>('FLYER_LETTER');
  const [newTemplate, setNewTemplate] = useState<TemplateId | ''>('');
  const [brand, setBrand] = useState<Brand>(NO_BRAND);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<DesignKey | null>(null);
  const generation = useRef(0);
  const brandGeneration = useRef(0);
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    const off = typeof window === 'undefined' ? () => {} : onShellPrivacyEvent(() => {
      ++generation.current; pending.current = null; setItems([]); setOpen({ state: 'NONE' }); setNotice(null); ++brandGeneration.current; setBrand(NO_BRAND); setLoad('LOADING');
    });
    return () => { off(); ++generation.current; };
  }, []);

  useEffect(() => {
    if (!scope) return;
    const current = ++generation.current, abort = new AbortController();
    api.list(scope, { status }, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)])).then(
      list => { if (current === generation.current) { setItems(list.designs); setLoad('READY'); } },
      error => { if (current === generation.current) setLoad(failure(error)); });
    return () => abort.abort();
  }, [selection?.organizationId, selection?.schoolId, status, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // Brand kit: best effort. Someone without branding access simply gets no school color or contact line.
  useEffect(() => {
    setBrand(NO_BRAND);
    if (!scope || !api.brand) return;
    const current = ++brandGeneration.current, abort = new AbortController();
    const owned = () => current === brandGeneration.current && !abort.signal.aborted;
    api.brand(scope, AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]), owned).then(b => { if (owned()) setBrand(b); }, () => {});
    return () => abort.abort();
  }, [selection?.organizationId, selection?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openDesign = useCallback((designId: string) => {
    if (!scope) return;
    const current = generation.current;
    setOpen({ state: 'LOADING', designId });
    api.get(scope, designId, AbortSignal.timeout(15000)).then(
      design => { if (current === generation.current) setOpen({ state: 'READY', design }); },
      () => { if (current === generation.current) setOpen({ state: 'FAILED', designId }); });
  }, [api, scope?.organizationId, scope?.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    const template = newTemplate || null;
    const input = createInput(newName || (template ? t(TEMPLATE_NAMES[template]) : t('newNameDefault')), newSize, template, language, brand);
    if (!scope || !input || busy) return;
    const fingerprint = JSON.stringify([scope.schoolId, input.name, input.sizeCode, input.document]);
    if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true); setNotice(null);
    try {
      const receipt = await api.save(scope, input, pending.current.key);
      pending.current = null; setNewName(''); setNewTemplate('');
      setOpen({ state: 'READY', design: receipt.design });
    } catch (error) {
      if (!(error instanceof DesignsUnknown)) pending.current = null;
      setNotice(refusalKey(error));
    } finally { setBusy(false); }
  };

  const statusKeys = useRef(new Map<string, string>());
  const changeStatus = async (row: CreativeDesignSummary, next: CreativeDesignStatus) => {
    if (!scope || busy) return;
    const id = `${row.designId}:${row.version}:${next}`;
    const key = statusKeys.current.get(id) ?? crypto.randomUUID();
    statusKeys.current.set(id, key);
    setBusy(true); setNotice(null);
    try {
      await api.setStatus(scope, { designId: row.designId, expectedVersion: row.version, status: next }, key);
      statusKeys.current.delete(id); setRefresh(n => n + 1);
    } catch (error) {
      if (!(error instanceof DesignsUnknown)) statusKeys.current.delete(id);
      setNotice(refusalKey(error));
      if (error instanceof DesignsRefusal) setRefresh(n => n + 1);
    } finally { setBusy(false); }
  };

  if (!scope) return <div className={s.page}><p className={s.notice}>{t('noSchool')}</p></div>;
  if (open.state === 'READY') {
    return (
      <div className={s.page}>
        <DesignEditor key={`${open.design.designId}:${open.design.version}`} scope={scope} design={open.design} language={language} api={api}
          onBack={() => { setOpen({ state: 'NONE' }); setRefresh(n => n + 1); }} onReload={() => openDesign(open.design.designId)} brand={brand} />
      </div>
    );
  }
  const when = (iso: string) => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <div className={s.page}>
      <header className={s.head}>
        <div>
          <h1>{t('title')}</h1>
          <p className={s.intro}>{t('intro')}</p>
        </div>
      </header>
      {load === 'DENIED' || load === 'SESSION' ? <p className={s.notice} data-tone="warn" role="alert">{t(load === 'DENIED' ? 'denied' : 'session')}</p> : null}
      {load === 'UNAVAILABLE' ? (
        <p className={s.notice} data-tone="warn" role="alert">{t('unavailable')} <button type="button" className={s.secondary} onClick={() => { setLoad('LOADING'); setRefresh(n => n + 1); }}>{t('retry')}</button></p>
      ) : null}
      {notice ? <p className={s.notice} data-tone="warn" role="alert">{t(notice)}</p> : null}
      {open.state === 'FAILED' ? <p className={s.notice} data-tone="warn" role="alert">{t('unavailable')}</p> : null}
      {load === 'READY' && status === 'ACTIVE' ? (
        <section className={s.card} aria-label={t('newTitle')}>
          <h2>{t('newTitle')}</h2>
          <form className={s.newForm} onSubmit={event => { event.preventDefault(); void create(); }}>
            <label className={s.field}>{t('newName')}
              <input name="newDesignName" value={newName} maxLength={CREATIVE_DESIGN_LIMITS.name} placeholder={t('newNameDefault')} onChange={event => setNewName(event.target.value)} />
            </label>
            <label className={s.field}>{t('newSize')}
              <select name="newDesignSize" value={newSize} onChange={event => setNewSize(event.target.value as CreativeDesignSizeCode)}>
                {CREATIVE_DESIGN_SIZE_CODES.map(code => <option key={code} value={code}>{sizeName(language, code)} ({sizeMeasure(code)})</option>)}
              </select>
            </label>
            <label className={s.field}>{t('startFrom')}
              <select name="newDesignTemplate" value={newTemplate} onChange={event => setNewTemplate(event.target.value as TemplateId | '')}>
                <option value="">{t('blank')}</option>
                {TEMPLATE_IDS.map(id => <option key={id} value={id}>{t(TEMPLATE_NAMES[id])}</option>)}
              </select>
            </label>
            <button type="submit" className={s.button} disabled={busy}>{t('newCreate')}</button>
          </form>
        </section>
      ) : null}
      {load === 'LOADING' ? <p className={s.meta} role="status">{t('loading')}</p> : null}
      {load === 'READY' ? (
        <section className={s.card} aria-label={t(status === 'ACTIVE' ? 'listActive' : 'listArchived')}>
          <div className={s.head}>
            <h2>{t(status === 'ACTIVE' ? 'listActive' : 'listArchived')}</h2>
            <button type="button" className={s.secondary} onClick={() => { setLoad('LOADING'); setStatus(status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE'); }}>
              {t(status === 'ACTIVE' ? 'showArchived' : 'showActive')}
            </button>
          </div>
          {items.length === 0 ? <p className={s.meta}>{t(status === 'ACTIVE' ? 'none' : 'noneArchived')}</p> : (
            <ul className={s.rows}>
              {items.map(row => (
                <li key={row.designId}>
                  <span className={s.rowMain}>
                    <strong>{row.name}</strong>
                    <span className={s.meta}>{sizeName(language, row.sizeCode)}, {sizeMeasure(row.sizeCode)}. {t('updated', { when: when(row.updatedAt) })}</span>
                  </span>
                  <button type="button" className={s.button} disabled={open.state === 'LOADING'} onClick={() => openDesign(row.designId)}>
                    {open.state === 'LOADING' && open.designId === row.designId ? t('loading') : t('open')}
                  </button>
                  <button type="button" className={s.secondary} disabled={busy} onClick={() => void changeStatus(row, row.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}>
                    {t(row.status === 'ACTIVE' ? 'archive' : 'restore')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
