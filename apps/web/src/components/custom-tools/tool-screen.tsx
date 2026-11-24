'use client';
import React, { useCallback, useMemo, useState } from 'react';
import type {
  CustomToolCapability, CustomToolDashboard, CustomToolDefinition, CustomToolDesign, CustomToolEntity, CustomToolField, CustomToolList,
  CustomToolRecord, CustomToolRecordList, CustomToolSummary, CustomToolView,
} from '@hon/contracts';
import { ToolFrame, useToolText, type ToolContext } from './frame';
import { customToolApi, type CustomToolApi, type ToolScope } from './http';
import { useCommands, useRead, type Outcome, type ReadState } from './hooks';
import { formValueOf, labelText, parseForm, valueText, type FormValue } from './model';
import type { CustomToolKey, T } from './copy';
import { makerHref, ToolIcon, toolHref } from './tools-home';
import styles from './custom-tools.module.css';

type RecordAction = 'CREATE' | 'UPDATE' | 'ARCHIVE' | 'RESTORE';
type Refs = CustomToolRecordList['refs'];
const NO_REFS: Refs = { students: {}, staff: {}, records: {} };
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** What one tool screen needs: the tool, the version shown and whether these are draft test records. */
export type ToolSession = Readonly<{ scope: ToolScope; tool: CustomToolSummary; definition: CustomToolDefinition; preview: boolean; caps: readonly CustomToolCapability[] }>;

const entityOf = (def: CustomToolDefinition, key: string): CustomToolEntity | undefined => def.entities.find(e => e.key === key);
const formFor = (def: CustomToolDefinition, entity: string): CustomToolView | undefined => def.views.find(v => v.type === 'FORM' && v.entity === entity);
const fieldsOf = (entity: CustomToolEntity, keys: readonly string[] | undefined) => (keys ?? []).map(k => entity.fields.find(f => f.key === k)).filter((f): f is CustomToolField => !!f);

/** Records in the view's order: the named sort field (missing values last), else newest first. */
export function sortRecords(records: readonly CustomToolRecord[], view: CustomToolView): CustomToolRecord[] {
  const out = [...records];
  const sort = view.sort;
  if (!sort) return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const dir = sort.direction === 'ASC' ? 1 : -1;
  return out.sort((a, b) => {
    const x = a.data[sort.field], y = b.data[sort.field];
    if (x === undefined || x === null) return y === undefined || y === null ? 0 : 1;
    if (y === undefined || y === null) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
    return String(x).localeCompare(String(y)) * dir;
  });
}

function LinkPicker({ session, field, value, label, api, onPick, t, disabled }: {
  session: ToolSession; field: CustomToolField; value: string; label: string; api: CustomToolApi; onPick: (id: string, label: string) => void; t: T; disabled: boolean;
}) {
  const [search, setSearch] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const kind = field.type === 'STUDENT_REF' ? 'STUDENT' : field.type === 'STAFF_REF' ? 'STAFF' : 'RECORD';
  const [options] = useRead(asked === null ? null : (signal, owned) => api.linkOptions(session.scope, session.tool.toolId,
    { kind, entity: kind === 'RECORD' ? field.entity ?? null : null, search: asked, preview: session.preview }, signal, owned), [asked]);
  return <div className={styles.block} data-testid={`custom-tool-picker-${field.key}`}>
    <span className={styles.meta}>{value ? label || t('none') : t('choose')}</span>
    <div className={styles.row}>
      <label className={styles.field}><span className={styles.meta}>{t('search')}</span>
        <input type="search" value={search} maxLength={60} disabled={disabled} onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setAsked(search.trim()); } }}/></label>
      <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={disabled} onClick={() => setAsked(search.trim())}>{t('search')}</button>
      {value && !field.required ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={disabled} onClick={() => onPick('', '')}>{t('cancel')}</button> : null}
    </div>
    {asked === null ? null : options.state === 'LOADING' ? <span className={styles.meta} role="status">{t('loading')}</span>
      : options.state !== 'READY' ? <span className={styles.meta} role="status">{t('unavailable')}</span>
      : options.value.options.length === 0 ? <span className={styles.meta}>{t('noMatches')}</span>
      : <div className={styles.row}>{options.value.options.map(o => <button key={o.id} type="button" className={`${styles.secondary} ${styles.small}`} disabled={disabled}
        aria-pressed={o.id === value} onClick={() => { onPick(o.id, o.label); setAsked(null); setSearch(''); }}>{o.label}</button>)}</div>}
  </div>;
}

function FieldInput({ session, field, value, refLabel, api, onChange, onRefLabel, t, language, disabled, invalid }: {
  session: ToolSession; field: CustomToolField; value: FormValue; refLabel: string; api: CustomToolApi; t: T; language: string; disabled: boolean; invalid: boolean;
  onChange: (v: FormValue) => void; onRefLabel: (label: string) => void;
}) {
  const label = `${labelText(field.label, language)}${field.required ? ' *' : ''}`;
  const common = { disabled, 'aria-invalid': invalid || undefined, 'data-testid': `custom-tool-input-${field.key}` } as const;
  const text = typeof value === 'string' ? value : '';
  switch (field.type) {
    case 'BOOLEAN': return <label className={styles.check}><input type="checkbox" checked={value === true} {...common} onChange={(e) => onChange(e.target.checked)}/>{label}</label>;
    case 'LONG_TEXT': return <label className={styles.field}>{label}<textarea rows={4} value={text} maxLength={field.maxLength ?? 2000} {...common} onChange={(e) => onChange(e.target.value)}/></label>;
    case 'INTEGER': case 'NUMBER': return <label className={styles.field}>{label}<input inputMode={field.type === 'INTEGER' ? 'numeric' : 'decimal'} value={text} {...common} onChange={(e) => onChange(e.target.value)}/></label>;
    case 'DATE': return <label className={styles.field}>{label}<input type="date" value={text} {...common} onChange={(e) => onChange(e.target.value)}/></label>;
    case 'CHOICE': return <label className={styles.field}>{label}<select value={text} {...common} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('choose')}</option>{(field.choices ?? []).map(c => <option key={c.key} value={c.key}>{labelText(c.label, language)}</option>)}</select></label>;
    case 'MULTI_CHOICE': {
      const picked = Array.isArray(value) ? value : [];
      return <fieldset className={styles.block} disabled={disabled} data-testid={`custom-tool-input-${field.key}`}><legend>{label}</legend><div className={styles.checks}>
        {(field.choices ?? []).map(c => <label key={c.key} className={styles.check}><input type="checkbox" checked={picked.includes(c.key)}
          onChange={(e) => onChange(e.target.checked ? [...picked, c.key] : picked.filter(k => k !== c.key))}/>{labelText(c.label, language)}</label>)}</div></fieldset>;
    }
    case 'STUDENT_REF': case 'STAFF_REF': case 'RECORD_REF':
      return <div className={styles.field}><span>{label}</span><LinkPicker session={session} field={field} value={text} label={refLabel} api={api} t={t} disabled={disabled}
        onPick={(id, l) => { onChange(id); onRefLabel(l); }}/></div>;
    default: return <label className={styles.field}>{label}<input value={text} maxLength={field.maxLength ?? 200} {...common} onChange={(e) => onChange(e.target.value)}/></label>;
  }
}

function RecordForm({ session, view, record, refs, api, ctx, locked, onSubmit, onCancel }: {
  session: ToolSession; view: CustomToolView; record: CustomToolRecord | null; refs: Refs; api: CustomToolApi; ctx: ToolContext; locked: boolean;
  onSubmit: (data: Record<string, unknown>) => void; onCancel?: (() => void) | undefined;
}) {
  const { t, language } = ctx;
  const entity = entityOf(session.definition, view.entity)!;
  const fields = fieldsOf(entity, view.fields);
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(fields.map(f => [f.key, formValueOf(f, record?.data[f.key])])));
  const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries(fields.flatMap(f => {
    const v = record?.data[f.key];
    if (typeof v !== 'string') return [];
    const map = f.type === 'STUDENT_REF' ? refs.students : f.type === 'STAFF_REF' ? refs.staff : f.type === 'RECORD_REF' ? refs.records : null;
    return map ? [[f.key, map[v] ?? '']] : [];
  })));
  const [problems, setProblems] = useState<string[]>([]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseForm(fields, values);
    setProblems(parsed.problems);
    if (parsed.problems.length) return;
    // An edit keeps the values of fields this form does not show: the server replaces the record's data as sent.
    const kept = record ? Object.fromEntries(entity.fields.filter(f => !fields.includes(f) && record.data[f.key] !== undefined).map(f => [f.key, record.data[f.key]])) : {};
    onSubmit({ ...kept, ...parsed.data });
  };
  return <form className={styles.form} onSubmit={submit} data-testid="custom-tool-form">
    <h3>{record ? `${t('edit')}: ${labelText(entity.label, language)}` : labelText(view.label, language)}</h3>
    {fields.map(f => <FieldInput key={f.key} session={session} field={f} value={values[f.key] ?? ''} refLabel={labels[f.key] ?? ''} api={api} t={t} language={language}
      disabled={locked} invalid={problems.includes(f.key)} onChange={(v) => setValues(s => ({ ...s, [f.key]: v }))} onRefLabel={(l) => setLabels(s => ({ ...s, [f.key]: l }))}/>)}
    {problems.length ? <p className={`${styles.notice} ${styles.warn}`} role="status">{t('checkFields', { fields: problems.map(k => labelText(entity.fields.find(f => f.key === k)?.label, language)).join(', ') })}</p> : null}
    <div className={styles.row}><button type="submit" className={styles.primary} disabled={locked}>{t('saveRecord')}</button>
      {onCancel ? <button type="button" className={styles.secondary} disabled={locked} onClick={onCancel}>{t('cancel')}</button> : null}</div>
  </form>;
}

function OutcomeNote({ outcome, entity, ctx, canRetry, onRetry }: { outcome: Outcome<RecordAction>; entity: CustomToolEntity | undefined; ctx: ToolContext; canRetry: boolean; onRetry: () => void }) {
  const { t, language } = ctx;
  if (!outcome) return null;
  if (outcome.kind === 'SENDING') return <p className={styles.meta} role="status">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.notice} role="status">{t(outcome.action === 'ARCHIVE' ? 'done_ARCHIVE_RECORD' : outcome.action === 'RESTORE' ? 'done_RESTORE_RECORD' : `done_${outcome.action}`)}</p>;
  const field = outcome.detail ? labelText(entity?.fields.find(f => f.key === outcome.detail)?.label, language) || outcome.detail : '';
  return <p className={`${styles.notice} ${styles.warn}`} role="alert">{t(`e_${outcome.kind}` as CustomToolKey, { field })}
    {canRetry ? <button type="button" className={styles.secondary} onClick={onRetry}>{t('tryAgain')}</button> : null}</p>;
}

function TableScreen({ session, view, api, ctx }: { session: ToolSession; view: CustomToolView; api: CustomToolApi; ctx: ToolContext }) {
  const { t, language } = ctx;
  const entity = entityOf(session.definition, view.entity)!;
  const columns = fieldsOf(entity, view.columns);
  const form = formFor(session.definition, view.entity);
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<CustomToolRecord | 'NEW' | null>(null);
  const [list, again] = useRead((signal, owned) => api.records(session.scope, session.tool.toolId, { entity: view.entity, preview: session.preview, archived, limit: 200 }, signal, owned),
    [session.tool.toolId, session.preview, view.entity, archived]);
  const commands = useCommands<RecordAction>((action, result) => { if (result && (action === 'CREATE' || action === 'UPDATE')) setEditing(null); again(); });
  const can = (c: CustomToolCapability) => session.caps.includes(c);
  const write = (action: RecordAction, record: CustomToolRecord | null, data: Record<string, unknown> | null) => commands.start(action, (key, signal, owned) =>
    api.writeRecord(session.scope, session.tool.toolId, { operation: action, recordId: record?.recordId ?? null, entity: view.entity,
      expectedVersion: record?.version ?? 0, preview: session.preview, data }, key, signal, owned));
  const refs = list.state === 'READY' ? list.value.refs : NO_REFS;
  const yesNo = [t('yes'), t('no')] as const;
  return <section className={styles.card} aria-label={labelText(view.label, language)} data-testid={`custom-tool-view-${view.key}`}>
    <div className={styles.cardHead}><h2>{labelText(view.label, language)}</h2>
      <div className={styles.row}>
        {form && can('CREATE') && !archived ? <button type="button" className={styles.primary} disabled={commands.locked || editing !== null} onClick={() => setEditing('NEW')} data-testid="custom-tool-add">{t('add')}</button> : null}
        {can('ARCHIVE') ? <button type="button" className={styles.secondary} disabled={commands.locked} onClick={() => { setArchived(a => !a); setEditing(null); }}>{t(archived ? 'hideArchived' : 'showArchived')}</button> : null}
        <button type="button" className={styles.secondary} onClick={again}>{t('refresh')}</button>
      </div></div>
    <OutcomeNote outcome={commands.outcome} entity={entity} ctx={ctx} canRetry={commands.canRetry} onRetry={commands.retry}/>
    {editing !== null && form ? <RecordForm key={editing === 'NEW' ? 'new' : editing.recordId} session={session} view={form} record={editing === 'NEW' ? null : editing} refs={refs} api={api} ctx={ctx}
      locked={commands.locked} onCancel={() => setEditing(null)} onSubmit={(data) => write(editing === 'NEW' ? 'CREATE' : 'UPDATE', editing === 'NEW' ? null : editing, data)}/> : null}
    {list.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : list.state !== 'READY' ? <p className={styles.meta} role="status">{t(list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : list.value.records.length === 0 ? <p className={styles.meta}>{t('empty')}</p>
      : <>
        <p className={styles.meta}>{t('total', { n: String(list.value.total) })}{list.value.total > list.value.records.length ? ` ${t('firstOnly', { n: String(list.value.records.length) })}` : ''}</p>
        <div className={styles.tableWrap}><table className={styles.table} data-testid="custom-tool-records">
          <thead><tr>{columns.map(c => <th key={c.key} scope="col">{labelText(c.label, language)}</th>)}<th scope="col"><span className={styles.meta}>{t('edit')}</span></th></tr></thead>
          <tbody>{sortRecords(list.value.records, view).map(r => <tr key={r.recordId} data-testid="custom-tool-record">
            {columns.map(c => <td key={c.key}>{valueText(c, r.data[c.key], refs, language, yesNo) || t('none')}</td>)}
            <td><div className={styles.row}>
              {!archived && form && can('EDIT') ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={commands.locked || editing !== null} onClick={() => setEditing(r)}>{t('edit')}</button> : null}
              {can('ARCHIVE') ? <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={commands.locked}
                onClick={() => write(archived ? 'RESTORE' : 'ARCHIVE', r, null)}>{t(archived ? 'restoreRecord' : 'archiveRecord')}</button> : null}
            </div></td>
          </tr>)}</tbody></table></div>
      </>}
  </section>;
}

function FormScreen({ session, view, api, ctx }: { session: ToolSession; view: CustomToolView; api: CustomToolApi; ctx: ToolContext }) {
  const [round, setRound] = useState(0);
  const commands = useCommands<RecordAction>((_action, result) => { if (result) setRound(n => n + 1); });
  const entity = entityOf(session.definition, view.entity);
  if (!session.caps.includes('CREATE')) return <p className={styles.meta}>{ctx.t('canNotAdd')}</p>;
  return <section className={styles.card} data-testid={`custom-tool-view-${view.key}`}>
    <OutcomeNote outcome={commands.outcome} entity={entity} ctx={ctx} canRetry={commands.canRetry} onRetry={commands.retry}/>
    <RecordForm key={round} session={session} view={view} record={null} refs={NO_REFS} api={api} ctx={ctx} locked={commands.locked}
      onSubmit={(data) => commands.start('CREATE', (key, signal, owned) => api.writeRecord(session.scope, session.tool.toolId,
        { operation: 'CREATE', recordId: null, entity: view.entity, expectedVersion: 0, preview: session.preview, data }, key, signal, owned))}/>
  </section>;
}

export function DashboardCards({ dashboard, ctx }: { dashboard: CustomToolDashboard; ctx: ToolContext }): React.ReactElement {
  const { t, language } = ctx;
  return <div className={styles.tiles}>{dashboard.cards.map(c => <article key={c.key} className={styles.tile} data-testid={`custom-tool-card-${c.key}`}>
    <h3>{labelText(c.label, language)}</h3>
    {c.kind === 'LEADERBOARD' ? (c.rows?.length ? <ol className={styles.board}>{c.rows.map(r => <li key={r.key}>
      {(typeof r.label === 'string' ? r.label : labelText(r.label, language)) || t('none')}: <strong>{r.value.toLocaleString(language)}</strong></li>)}</ol>
      : <p className={styles.meta}>{t('dashEmpty')}</p>)
      : <p className={styles.number}>{c.value === null ? t('none') : c.value.toLocaleString(language)}</p>}
  </article>)}</div>;
}

function DashboardScreen({ session, view, api, ctx }: { session: ToolSession; view: CustomToolView; api: CustomToolApi; ctx: ToolContext }) {
  const [dash, again] = useRead((signal, owned) => api.dashboard(session.scope, session.tool.toolId, view.key, session.preview, signal, owned), [session.tool.toolId, view.key, session.preview]);
  const { t, language } = ctx;
  return <section className={styles.card} data-testid={`custom-tool-view-${view.key}`}>
    <div className={styles.cardHead}><h2>{labelText(view.label, language)}</h2><button type="button" className={styles.secondary} onClick={again}>{t('refresh')}</button></div>
    {dash.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
      : dash.state !== 'READY' ? <p className={styles.meta} role="status">{t(dash.state === 'DENIED' ? 'denied' : 'unavailable')}</p>
      : <DashboardCards dashboard={dash.value} ctx={ctx}/>}
  </section>;
}

/** One tool's section: its tabs (the published navigation) and the chosen screen. */
export function ToolSection({ session, initialView, api, ctx }: { session: ToolSession; initialView: string | null; api: CustomToolApi; ctx: ToolContext }): React.ReactElement {
  const { t, language } = ctx;
  const tabs = session.definition.navigation.map(k => session.definition.views.find(v => v.key === k)).filter((v): v is CustomToolView => !!v);
  const [current, setCurrent] = useState(() => tabs.find(v => v.key === initialView)?.key ?? tabs[0]?.key ?? null);
  const view = tabs.find(v => v.key === current);
  return <div className={styles.stack} data-testid="custom-tool-section">
    <div className={styles.cardHead}>
      <div className={styles.row}><ToolIcon icon={session.definition.icon}/><h2>{labelText(session.definition.name, language)}</h2>
        {session.preview ? <span className={styles.chip} data-state="PREVIEW">{t('v_DRAFT')}</span> : null}</div>
      {session.preview ? <a className={styles.secondary} href={toolHref(session.tool.toolKey)}>{t('exitPreview')}</a> : null}
    </div>
    {session.preview ? <p className={`${styles.notice} ${styles.warn}`} data-testid="custom-tool-preview-banner">{t('previewBanner')}</p> : null}
    {session.definition.description ? <p className={styles.intro}>{labelText(session.definition.description, language)}</p> : null}
    {tabs.length > 1 ? <div className={styles.tabs} role="tablist">{tabs.map(v => <button key={v.key} type="button" role="tab" className={styles.tab}
      aria-selected={v.key === current} aria-pressed={v.key === current} onClick={() => setCurrent(v.key)} data-testid={`custom-tool-tab-${v.key}`}>{labelText(v.label, language)}</button>)}</div> : null}
    {!view ? <p className={styles.meta}>{t('noScreens')}</p>
      : view.type === 'TABLE' ? <TableScreen key={view.key} session={session} view={view} api={api} ctx={ctx}/>
      : view.type === 'FORM' ? <FormScreen key={view.key} session={session} view={view} api={api} ctx={ctx}/>
      : <DashboardScreen key={view.key} session={session} view={view} api={api} ctx={ctx}/>}
  </div>;
}

/** Which tool and version a request names, from the list the server sent (never from the address alone). */
export function resolveTool(list: CustomToolList, toolKey: string, preview: boolean): { tool: CustomToolSummary; version: number | null; preview: boolean } | 'NOT_FOUND' | 'NOT_PUBLISHED' {
  const tool = list.tools.find(x => x.toolKey === toolKey);
  if (!tool || tool.status !== 'ACTIVE') return 'NOT_FOUND';
  if (preview && list.canDesign && tool.draftVersion !== null) return { tool, version: tool.draftVersion, preview: true };
  if (tool.publishedVersion === null) return 'NOT_PUBLISHED';
  return { tool, version: list.canDesign ? tool.publishedVersion : null, preview: false };
}

function ScreenBody({ ctx, api, toolKey, view, preview }: { ctx: ToolContext; api: CustomToolApi; toolKey: string; view: string | null; preview: boolean }) {
  const { t } = ctx;
  const [list] = useRead((signal, owned) => api.list(ctx.scope, signal, owned), [ctx.scope.organizationId, ctx.scope.schoolId]);
  const target = list.state === 'READY' ? resolveTool(list.value, toolKey, preview) : null;
  const toolId = target && typeof target === 'object' ? target.tool.toolId : null, version = target && typeof target === 'object' ? target.version : null;
  const [design] = useRead<CustomToolDesign>(toolId ? (signal, owned) => api.design(ctx.scope, toolId, version, signal, owned) : null, [toolId, version]);
  const session = useMemo<ToolSession | null>(() => {
    if (!target || typeof target !== 'object' || design.state !== 'READY') return null;
    const v = design.value.version;
    if (v.versionNo !== (target.version ?? target.tool.publishedVersion)) return null;
    return { scope: ctx.scope, tool: target.tool, definition: v.definition, preview: target.preview, caps: target.tool.capabilities };
  }, [target, design, ctx.scope]);
  const canDesign = list.state === 'READY' && list.value.canDesign;
  if (list.state === 'LOADING' || (target && typeof target === 'object' && design.state === 'LOADING')) return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (list.state !== 'READY') return <p className={styles.notice} role="status">{t(list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>;
  if (target === 'NOT_PUBLISHED') return <p className={styles.notice} role="status">{t('notPublished')}{canDesign ? <a className={styles.secondary} href={makerHref(list.value.tools.find(x => x.toolKey === toolKey)?.toolId)}>{t('design')}</a> : null}</p>;
  if (target === 'NOT_FOUND' || !session) return <p className={styles.notice} role="status">{t('notFound')}</p>;
  return <ToolSection key={`${session.tool.toolId}:${session.preview}`} session={session} initialView={view} api={api} ctx={ctx}/>;
}

/** /staff/tools/[toolKey]: one published tool (or, for a designer, its draft with test records). The API decides access. */
export function ToolScreen({ toolKey, view = null, preview = false, api = customToolApi }: { toolKey: string; view?: string | null; preview?: boolean; api?: CustomToolApi }): React.ReactElement {
  const t = useToolText();
  const key = KEY.test(toolKey) ? toolKey : null;
  const okView = view && /^[a-z][a-z0-9_]{0,39}$/.test(view) ? view : null;
  const body = useCallback((ctx: ToolContext) => key ? <ScreenBody ctx={ctx} api={api} toolKey={key} view={okView} preview={preview}/> : <p className={styles.notice} role="status">{ctx.t('notFound')}</p>, [key, okView, preview, api]);
  return <ToolFrame title={t('homeTitle')} intro="" testId="custom-tool-screen">{body}</ToolFrame>;
}
export type { ReadState };
