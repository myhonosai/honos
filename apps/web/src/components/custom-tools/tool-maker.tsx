'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CUSTOM_TOOL_KEY, CUSTOM_TOOL_LIMITS, type CustomToolCapability, type CustomToolChangeOperation, type CustomToolDefinition, type CustomToolDesign, type CustomToolList } from '@hon/contracts';
import type { CustomToolKey } from './copy';
import { describeDesign } from './describe';
import { ToolFrame, useToolText, type ToolContext } from './frame';
import { customToolApi, type CustomToolApi } from './http';
import { useCommands, useRead, type Outcome } from './hooks';
import { DesignEditor, finalizeKeys, tidyDefinition } from './maker-editor';
import { designProblems, designTooLarge, labelText, problemPlace } from './model';
import { cleanPrompt, standInDrafter, type ToolDrafter } from './drafter';
import { TOOL_TEMPLATES, templateCopy } from './templates';
import { makerHref, ToolIcon, toolHref, toolStatus } from './tools-home';
import styles from './custom-tools.module.css';

type MakerAction = 'save' | CustomToolChangeOperation;
/** What is open in the editor: a new tool (from a description or a template), or a saved tool (optionally an older version, read only). */
type Target = { kind: 'NONE' } | { kind: 'NEW'; seed: Readonly<{ toolKey: string; definition: CustomToolDefinition }>; n: number } | { kind: 'TOOL'; toolId: string; version: number | null };
type Working = Readonly<{ base: string; toolKey: string; definition: CustomToolDefinition }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fieldKeys = (defs: readonly CustomToolDefinition[]) => {
  const out = new Map<string, Set<string>>();
  for (const d of defs) for (const e of d.entities) { const s = out.get(e.key) ?? new Set<string>(); e.fields.forEach(f => s.add(f.key)); out.set(e.key, s); }
  return out;
};

/** Problems in words: the server's paths (or the browser's) name the part of the design to fix. */
function problemText(path: string, def: CustomToolDefinition, ctx: ToolContext): string {
  const place = problemPlace(path, def, ctx.language);
  if (place) return ctx.t('problemAt', { place });
  const part = /^[a-z]+/.exec(path)?.[0] ?? 'definition';
  const key = `part_${part}` as CustomToolKey;
  return ctx.t('problemGeneral', { part: ctx.t(['name', 'description', 'icon', 'entities', 'views', 'navigation', 'access'].includes(part) ? key : 'part_definition') });
}

function OutcomeNote({ outcome, def, ctx, canRetry, onRetry }: { outcome: Outcome<MakerAction>; def: CustomToolDefinition | null; ctx: ToolContext; canRetry: boolean; onRetry: () => void }) {
  const { t } = ctx;
  if (!outcome) return null;
  if (outcome.kind === 'SENDING') return <p className={styles.meta} role="status">{t('sending')}</p>;
  if (outcome.kind === 'DONE') return <p className={styles.notice} role="status" data-testid="custom-tool-maker-done">{t(outcome.action === 'save' ? 'done_save' : `done_${outcome.action}` as CustomToolKey)}</p>;
  const text = outcome.kind === 'DESIGN' && outcome.detail && def ? t('serverProblem', { place: problemText(outcome.detail, def, ctx) }) : t(`e_${outcome.kind}` as CustomToolKey, { field: outcome.detail ?? '' });
  return <p className={`${styles.notice} ${styles.warn}`} role="alert" data-testid="custom-tool-maker-error">{text}
    {canRetry ? <button type="button" className={styles.secondary} onClick={onRetry}>{t('tryAgain')}</button> : null}</p>;
}

function Versions({ design, ctx, locked, open, onView, onRestore }: { design: CustomToolDesign; ctx: ToolContext; locked: boolean; open: number; onView: (n: number) => void; onRestore: (n: number) => void }) {
  const { t, language } = ctx;
  const draftOpen = design.tool.draftVersion !== null;
  return <section className={styles.card} aria-labelledby="ct-versions" data-testid="custom-tool-versions"><h2 id="ct-versions">{t('versionsTitle')}</h2>
    <p className={styles.meta}>{t(draftOpen ? 'restoreBlocked' : 'restoreHelp')}</p>
    <ul className={styles.list}>{[...design.versions].sort((a, b) => b.versionNo - a.versionNo).map(v => <li key={v.versionNo} data-testid="custom-tool-version">
      <div className={styles.row}><strong>{v.versionNo}</strong><span className={styles.chip} data-state={v.status}>{t(`v_${v.status}` as CustomToolKey)}</span>
        <span className={styles.meta}>{t(`o_${v.origin}` as CustomToolKey, { n: String(v.restoredFrom ?? '') })} · {new Date(v.updatedAt).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })}</span></div>
      <div className={styles.row}>
        <button type="button" className={`${styles.secondary} ${styles.small}`} disabled={locked || v.versionNo === open} onClick={() => onView(v.versionNo)}>{t('view')}</button>
        {(v.status === 'SUPERSEDED' || v.status === 'DISCARDED' || v.status === 'PUBLISHED') && !draftOpen ? <button type="button" className={`${styles.secondary} ${styles.small}`}
          disabled={locked || design.tool.status !== 'ACTIVE'} onClick={() => onRestore(v.versionNo)} data-testid={`custom-tool-restore-${v.versionNo}`}>{t('restore')}</button> : null}
      </div></li>)}</ul>
  </section>;
}

const IDEAS = ['idea_1', 'idea_2', 'idea_3', 'idea_4'] as const;
const USE_CAPS: CustomToolCapability[] = ['VIEW', 'CREATE', 'EDIT'];

/** The start: one plain-language box. Ready-made designs and existing tools sit underneath. */
function Start({ list, ctx, drafter, onPick }: { list: CustomToolList; ctx: ToolContext; drafter: ToolDrafter; onPick: (t: Target) => void }) {
  const { t, language } = ctx;
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<'IDLE' | 'BUSY' | 'UNSURE'>('IDLE');
  const build = async (text: string) => {
    if (state === 'BUSY' || !cleanPrompt(text)) return;
    setState('BUSY');
    const out = await drafter.create(text, list.tools.map(x => x.toolKey)).catch(() => ({ kind: 'UNSURE' as const }));
    if (out.kind !== 'OK') { setState('UNSURE'); return; }
    setState('IDLE');
    onPick({ kind: 'NEW', seed: { toolKey: out.toolKey, definition: out.definition }, n: Date.now() });
  };
  return <>
    <section className={styles.card} aria-labelledby="ct-ask"><h2 id="ct-ask">{t('askTitle')}</h2>
      <p className={styles.meta}>{t('askHelp')}</p>
      <form onSubmit={(e) => { e.preventDefault(); void build(prompt); }} className={styles.stack}>
        <label className={styles.field}>{t('askLabel')}
          <textarea rows={3} maxLength={1000} value={prompt} placeholder={t('askPlaceholder')} onChange={(e) => { setPrompt(e.target.value); if (state === 'UNSURE') setState('IDLE'); }}
            data-testid="custom-tool-ask"/></label>
        <div className={styles.row}><button type="submit" className={styles.primary} disabled={state === 'BUSY' || !cleanPrompt(prompt)} data-testid="custom-tool-build">
          {t(state === 'BUSY' ? 'building' : 'build')}</button></div>
      </form>
      {state === 'UNSURE' ? <p className={`${styles.notice} ${styles.warn}`} role="alert">{t('unsure')}</p> : null}
      <p className={styles.meta}>{t('ideas')}</p>
      <div className={styles.row}>{IDEAS.map(k => <button key={k} type="button" className={`${styles.secondary} ${styles.small}`} disabled={state === 'BUSY'}
        onClick={() => { setPrompt(t(k)); void build(t(k)); }} data-testid={`custom-tool-${k}`}>{t(k)}</button>)}</div>
      {!drafter.real ? <p className={styles.meta} data-testid="custom-tool-stand-in">{t('standInNote')}</p> : null}
    </section>
    {list.tools.length ? <section className={styles.card} aria-labelledby="ct-yours"><h2 id="ct-yours">{t('yourTools')}</h2>
      <ul className={`${styles.tiles} ${styles.list}`}>{list.tools.map(tool => <li key={tool.toolId} className={styles.tile}>
        <div className={styles.row}><ToolIcon icon={tool.icon}/><h3>{labelText(tool.name, language)}</h3></div>
        <div className={styles.row}>{toolStatus(tool, t).map(s => <span key={s.text} className={styles.chip} data-state={s.state}>{s.text}</span>)}</div>
        <button type="button" className={styles.secondary} onClick={() => onPick({ kind: 'TOOL', toolId: tool.toolId, version: null })}>{t('change')}</button>
      </li>)}</ul></section> : null}
    <details className={`${styles.card} ${styles.more}`}><summary>{t('templatesInstead')}</summary>
      <ul className={`${styles.tiles} ${styles.list}`}>{TOOL_TEMPLATES.map(tp => <li key={tp.key} className={styles.tile}>
        <div className={styles.row}><ToolIcon icon={tp.definition.icon}/><h3>{t(`tpl_${tp.key}` as CustomToolKey)}</h3></div>
        <p className={styles.meta}>{t(`tplHelp_${tp.key}` as CustomToolKey)}</p>
        <button type="button" className={styles.secondary} onClick={() => { const c = templateCopy(tp.key); onPick({ kind: 'NEW', seed: { toolKey: c.toolKey, definition: c.definition }, n: Date.now() }); }}
          data-testid={`custom-tool-template-${tp.key}`}>{t('newTool')}</button>
      </li>)}</ul></details>
  </>;
}

/** "Change it by asking": the drafter edits the working design; nothing is saved until the owner publishes. */
function AskChange({ def, ctx, drafter, disabled, onChange }: { def: CustomToolDefinition; ctx: ToolContext; drafter: ToolDrafter; disabled: boolean; onChange: (d: CustomToolDefinition) => void }) {
  const { t } = ctx;
  const [prompt, setPrompt] = useState('');
  const [state, setState] = useState<'IDLE' | 'BUSY' | 'UNSURE' | 'DONE'>('IDLE');
  const apply = async () => {
    if (state === 'BUSY' || !cleanPrompt(prompt)) return;
    setState('BUSY');
    const out = await drafter.change(prompt, def).catch(() => ({ kind: 'UNSURE' as const }));
    if (out.kind !== 'OK') { setState('UNSURE'); return; }
    onChange(out.definition); setPrompt(''); setState('DONE');
  };
  return <section className={styles.card} aria-labelledby="ct-change"><h2 id="ct-change">{t('changeTitle')}</h2>
    <form onSubmit={(e) => { e.preventDefault(); void apply(); }} className={styles.stack}>
      <label className={styles.field}>{t('changeLabel')}
        <textarea rows={2} maxLength={1000} value={prompt} placeholder={t('changePlaceholder')} disabled={disabled}
          onChange={(e) => { setPrompt(e.target.value); if (state !== 'BUSY') setState('IDLE'); }} data-testid="custom-tool-change"/></label>
      <div className={styles.row}><button type="submit" className={styles.secondary} disabled={disabled || state === 'BUSY' || !cleanPrompt(prompt)} data-testid="custom-tool-apply">
        {t(state === 'BUSY' ? 'building' : 'applyChange')}</button></div>
    </form>
    {state === 'UNSURE' ? <p className={`${styles.notice} ${styles.warn}`} role="alert" data-testid="custom-tool-unsure">{t('unsureChange')}</p> : null}
    {state === 'DONE' ? <p className={styles.notice} role="status" data-testid="custom-tool-changed">{t('changedNote')}</p> : null}
  </section>;
}

type Who = 'OWNERS' | 'ALL' | 'SOME';
/** "Who can use it" as one question. Chosen roles can see, add and edit records; archiving stays with tool makers. */
function WhoCanUse({ def, roles, ctx, disabled, onChange }: { def: CustomToolDefinition; roles: ReadonlyArray<{ roleId: string; name: string }> | null; ctx: ToolContext; disabled: boolean; onChange: (d: CustomToolDefinition) => void }) {
  const { t } = ctx;
  const given = new Set(def.access.map(a => a.roleId));
  const derived: Who = !given.size ? 'OWNERS' : roles && roles.length && roles.every(r => given.has(r.roleId)) ? 'ALL' : 'SOME';
  const [picked, setPicked] = useState<Who | null>(null);
  const who = picked === 'SOME' && derived === 'OWNERS' ? 'SOME' : derived;
  if (roles === null) return <section className={styles.card} aria-labelledby="ct-who"><h2 id="ct-who">{t('whoTitle')}</h2><p className={styles.meta}>{t('whoAfterPublish')}</p></section>;
  const usable = roles.slice(0, CUSTOM_TOOL_LIMITS.accessRules);
  const rule = (roleId: string) => def.access.find(a => a.roleId === roleId) ?? { roleId, capabilities: USE_CAPS };
  const setAccess = (ids: string[]) => onChange({ ...def, access: usable.filter(r => ids.includes(r.roleId)).map(r => rule(r.roleId)) });
  const choose = (w: Who) => { setPicked(w); if (w === 'OWNERS') setAccess([]); else if (w === 'ALL') setAccess(usable.map(r => r.roleId)); };
  return <section className={styles.card} aria-labelledby="ct-who"><h2 id="ct-who">{t('whoTitle')}</h2>
    {!roles.length ? <p className={styles.meta}>{t('noRoles')}</p> : <fieldset className={styles.checks} disabled={disabled} aria-labelledby="ct-who" data-testid="custom-tool-who">
      {(['OWNERS', 'ALL', 'SOME'] as const).map(w => <label key={w}><input type="radio" name="ct-who" checked={who === w} onChange={() => choose(w)} data-testid={`custom-tool-who-${w}`}/> {t(`who_${w}` as CustomToolKey)}</label>)}
      {who === 'SOME' ? <div className={styles.checks}>{usable.map(r => <label key={r.roleId}><input type="checkbox" checked={given.has(r.roleId)}
        onChange={(e) => setAccess(e.target.checked ? [...given, r.roleId] : [...given].filter(x => x !== r.roleId))} data-testid="custom-tool-who-role"/> {r.name}</label>)}</div> : null}
    </fieldset>}
  </section>;
}

function MakerBody({ ctx, api, drafter, initialTool, keep }: { ctx: ToolContext; api: CustomToolApi; drafter: ToolDrafter; initialTool: string | null; keep: React.MutableRefObject<Working | null> }) {
  const { t, language, scope } = ctx;
  const [target, setTarget] = useState<Target>(() => initialTool ? { kind: 'TOOL', toolId: initialTool, version: null } : { kind: 'NONE' });
  const [list, againList] = useRead((signal, owned) => api.list(scope, signal, owned), [scope.organizationId, scope.schoolId]);
  const toolId = target.kind === 'TOOL' ? target.toolId : null, version = target.kind === 'TOOL' ? target.version : null;
  const [design, againDesign] = useRead<CustomToolDesign>(toolId ? (signal, owned) => api.design(scope, toolId, version, signal, owned) : null, [toolId, version]);
  const loaded = design.state === 'READY' && target.kind === 'TOOL' && design.value.tool.toolId.toLowerCase() === target.toolId.toLowerCase() ? design.value : null;

  // The working copy: what the owner is editing. It survives a privacy remount (it holds the design only, no family data).
  const baseId = target.kind === 'NEW' ? `${scope.schoolId}|new:${target.n}` : loaded ? `${scope.schoolId}|${loaded.tool.toolId}:${loaded.version.versionNo}:${loaded.tool.revision}` : null;
  const [working, setWorking] = useState<Working | null>(() => keep.current);
  useEffect(() => {
    if (!baseId) return;
    setWorking(w => {
      if (w && w.base === baseId) return w;
      if (target.kind === 'NEW') return { base: baseId, toolKey: target.seed.toolKey, definition: structuredClone(target.seed.definition) };
      return loaded ? { base: baseId, toolKey: loaded.tool.toolKey, definition: structuredClone(loaded.version.definition) } : w;
    });
  }, [baseId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { keep.current = working; }, [working, keep]);

  // "Publish" saves first when there are changes, then publishes the draft the save returned.
  const publishAfterSave = useRef(false);
  const startRef = useRef<((action: MakerAction, send: Parameters<ReturnType<typeof useCommands<MakerAction>>['start']>[1]) => boolean) | null>(null);
  const commands = useCommands<MakerAction>((action, result) => {
    const next = result as CustomToolDesign | null;
    const chain = action === 'save' && publishAfterSave.current && next && next.tool.draftVersion !== null;
    publishAfterSave.current = false;
    if (next) { keep.current = null; setWorking(null); setTarget({ kind: 'TOOL', toolId: next.tool.toolId, version: null }); }
    if (chain && next && startRef.current) {
      const input = { operation: 'PUBLISH' as const, expectedRevision: next.tool.revision, version: next.tool.draftVersion };
      startRef.current('PUBLISH', (key, signal, owned) => api.change(scope, next.tool.toolId, input, key, signal, owned));
    }
    againList(); againDesign();
  });
  startRef.current = commands.start;

  const current = working && working.base === baseId ? working : null;
  const def = current?.definition ?? null;
  const isNew = target.kind === 'NEW';
  const viewingOld = !!loaded && loaded.version.status !== 'DRAFT' && loaded.version.versionNo !== loaded.tool.publishedVersion;
  const archived = loaded?.tool.status === 'ARCHIVED';
  const readOnly = viewingOld || archived || commands.locked;
  const dirty = !!def && (isNew || (!!loaded && JSON.stringify(def) !== JSON.stringify(loaded.version.definition)));
  const savedFields = useMemo(() => fieldKeys(loaded ? [loaded.version.definition] : []), [loaded]);
  // Fields of a saved (non-draft) version keep their type; for a draft the server makes the same check on save.
  const publishedFields = useMemo(() => fieldKeys(loaded && loaded.version.status !== 'DRAFT' ? [loaded.version.definition] : []), [loaded]);
  const prepared = useMemo(() => def ? finalizeKeys(tidyDefinition(def), savedFields) : null, [def, savedFields]);
  const problems = prepared ? designProblems(prepared) : [];
  const keyOk = !isNew || (!!current && CUSTOM_TOOL_KEY.test(current.toolKey));
  const roles = loaded?.roles ?? null;
  const sentences = prepared && !problems.length ? describeDesign(prepared, roles ?? [], language, t).filter((_, i, all) => i !== all.length - 1) : [];
  const ready = !problems.length && keyOk && !!prepared && !designTooLarge(prepared);

  const save = (thenPublish: boolean) => {
    if (!prepared || !ready) return;
    const input = isNew ? { toolId: null, toolKey: current!.toolKey, expectedRevision: 0, definition: prepared }
      : { toolId: loaded!.tool.toolId, toolKey: null, expectedRevision: loaded!.tool.revision, definition: prepared };
    publishAfterSave.current = thenPublish;
    if (!commands.start('save', (key, signal, owned) => api.saveDraft(scope, input, key, signal, owned))) publishAfterSave.current = false;
  };
  const change = (operation: CustomToolChangeOperation, v: number | null) => {
    if (!loaded) return;
    commands.start(operation, (key, signal, owned) => api.change(scope, loaded.tool.toolId, { operation, expectedRevision: loaded.tool.revision, version: v }, key, signal, owned));
  };
  const pick = (next: Target) => { if (commands.locked) return; commands.clear(); keep.current = null; setWorking(null); setTarget(next); };
  const edit = (d: CustomToolDefinition) => setWorking(w => w ? { ...w, definition: d } : w);

  if (list.state === 'LOADING') return <p className={styles.meta} role="status">{t('loading')}</p>;
  if (list.state !== 'READY') return <p className={styles.notice} role="status">{t(list.state === 'DENIED' ? 'denied' : 'unavailable')}</p>;
  if (!list.value.canDesign) return <p className={styles.notice} role="status" data-testid="custom-tool-maker-denied">{t('denied')}</p>;
  if (target.kind === 'NONE') return <Start list={list.value} ctx={ctx} drafter={drafter} onPick={pick}/>;
  if (target.kind === 'TOOL' && design.state !== 'READY') return design.state === 'LOADING' ? <p className={styles.meta} role="status">{t('loading')}</p>
    : <p className={styles.notice} role="status">{t(design.state === 'GONE' ? 'notFound' : design.state === 'DENIED' ? 'denied' : 'unavailable')}
      <button type="button" className={styles.secondary} onClick={() => pick({ kind: 'NONE' })}>{t('close')}</button></p>;
  if (!def) return <p className={styles.meta} role="status">{t('loading')}</p>;

  const tool = loaded?.tool ?? null;
  const draft = tool?.draftVersion ?? null;
  const canPublish = dirty || draft !== null;
  return <div className={styles.stack} data-testid="custom-tool-maker">
    <div className={styles.cardHead}>
      <div className={styles.row}><ToolIcon icon={def.icon}/><h2>{labelText(def.name, language) || t('newTool')}</h2>
        {tool ? toolStatus(tool, t).map(s => <span key={s.text} className={styles.chip} data-state={s.state}>{s.text}</span>) : null}</div>
      <div className={styles.row}>
        <button type="button" className={styles.secondary} disabled={commands.locked} onClick={() => pick({ kind: 'NONE' })}>{t(isNew ? 'startOver' : 'close')}</button>
        {tool && tool.publishedVersion !== null && !archived ? <a className={styles.secondary} href={toolHref(tool.toolKey)}>{t('openTool')}</a> : null}
      </div>
    </div>
    <OutcomeNote outcome={commands.outcome} def={prepared} ctx={ctx} canRetry={commands.canRetry} onRetry={commands.retry}/>
    {archived ? <p className={`${styles.notice} ${styles.warn}`}>{t('archivedNote')}</p> : null}
    {viewingOld && loaded ? <p className={`${styles.notice} ${styles.warn}`}>{t('viewingOld', { n: String(loaded.version.versionNo) })}</p> : null}
    <section className={styles.card} aria-labelledby="ct-review"><h2 id="ct-review">{t('madeTitle')}</h2>
      {problems.length || !keyOk ? <div className={`${styles.notice} ${styles.warn}`} data-testid="custom-tool-problems"><strong>{t('problemsTitle')}</strong>
        <ul className={styles.problems}>{!keyOk ? <li>{t('toolKeyHelp')}</li> : null}{problems.map(pth => <li key={pth}>{problemText(pth, prepared!, ctx)}</li>)}</ul></div>
        : prepared && designTooLarge(prepared) ? <p className={`${styles.notice} ${styles.warn}`}>{t('tooLarge')}</p>
        : <ul className={styles.review} data-testid="custom-tool-review">{sentences.map((s, i) => <li key={i}>{s}</li>)}</ul>}
      <p className={styles.meta}>{t('rv_safe')}</p>
    </section>
    {!viewingOld && !archived ? <AskChange def={def} ctx={ctx} drafter={drafter} disabled={readOnly} onChange={edit}/> : null}
    {!viewingOld && !archived ? <WhoCanUse def={def} roles={roles} ctx={ctx} disabled={readOnly} onChange={edit}/> : null}
    {!viewingOld && !archived ? <section className={styles.card} aria-labelledby="ct-actions"><h2 id="ct-actions">{t('publish')}</h2>
      <p className={styles.meta}>{t('publishHelp')}</p>
      {dirty && !isNew ? <p className={styles.warnText} role="status">{t('unsaved')}</p> : null}
      <div className={styles.row}>
        <button type="button" className={styles.primary} disabled={commands.locked || !canPublish || !ready}
          onClick={() => dirty ? save(true) : change('PUBLISH', draft)} data-testid="custom-tool-publish">{t('publish')}</button>
        <button type="button" className={styles.secondary} disabled={commands.locked || !dirty || !ready} onClick={() => save(false)} data-testid="custom-tool-save">{t('save')}</button>
        {tool && draft !== null && !dirty ? <a className={styles.secondary} href={toolHref(tool.toolKey, { preview: '1' })} data-testid="custom-tool-preview">{t('preview')}</a> : null}
        {tool && draft !== null ? <button type="button" className={styles.secondary} disabled={commands.locked} onClick={() => change('DISCARD_DRAFT', draft)} data-testid="custom-tool-discard">{t('discard')}</button> : null}
      </div>
    </section> : null}
    <details className={`${styles.card} ${styles.more}`} data-testid="custom-tool-advanced"><summary>{t('advanced')}</summary>
      <div className={styles.stack}>
        {isNew ? <div><label className={styles.field}>{t('toolKey')}
          <input value={current!.toolKey} maxLength={40} disabled={commands.locked} data-testid="custom-tool-key" aria-invalid={!keyOk || undefined}
            onChange={(e) => setWorking(w => w ? { ...w, toolKey: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') } : w)}/></label>
          <p className={styles.meta}>{t('toolKeyHelp')}</p></div> : null}
        <DesignEditor definition={def} onChange={edit} readOnly={readOnly}
          savedFields={savedFields} publishedFields={publishedFields} roles={roles} language={language} t={t}/>
        {loaded ? <Versions design={loaded} ctx={ctx} locked={commands.locked} open={loaded.version.versionNo}
          onView={(n) => pick({ kind: 'TOOL', toolId: loaded.tool.toolId, version: n })} onRestore={(n) => change('RESTORE', n)}/> : null}
        {tool ? <div className={styles.row}><button type="button" className={styles.secondary} disabled={commands.locked}
          onClick={() => change(archived ? 'UNARCHIVE' : 'ARCHIVE', null)} data-testid="custom-tool-archive">{t(archived ? 'unarchive' : 'archive')}</button></div> : null}
      </div>
    </details>
  </div>;
}

/** /staff/tool-maker: describe a tool in plain words, check it, publish; plus advanced editing, versions, publish, restore and archive custom tools. The API refuses anyone without custom_tool.design. */
export function ToolMaker({ initialTool = null, api = customToolApi, drafter = standInDrafter }: { initialTool?: string | null; api?: CustomToolApi; drafter?: ToolDrafter }): React.ReactElement {
  const t = useToolText();
  const keep = useRef<Working | null>(null);
  const tool = initialTool && UUID.test(initialTool) ? initialTool.toLowerCase() : null;
  const body = useCallback((ctx: ToolContext) => <MakerBody ctx={ctx} api={api} drafter={drafter} initialTool={tool} keep={keep}/>, [api, drafter, tool]);
  return <ToolFrame title={t('makerTitle')} intro={t('makerIntro')} testId="custom-tool-maker-page">{body}</ToolFrame>;
}
export { makerHref };
