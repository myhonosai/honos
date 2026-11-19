'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONVERSATION_AI_CHANNELS, CONVERSATION_AI_ITEM_KINDS, CONVERSATION_AI_LANGUAGES, CONVERSATION_AI_LIMITS, CONVERSATION_AI_MODES,
  conversationAiHandoffWordsOk, conversationAiTextOk,
  type ConversationAiItem, type ConversationAiItemInput, type ConversationAiItemKind, type ConversationAiKnowledge, type ConversationAiLanguage,
  type ConversationAiOverview, type ConversationAiSettingsInput, type ConversationAiUploadReceipt,
} from '@hon/contracts';
import { useSchoolShell } from '../school-shell/context';
import { onShellPrivacyEvent } from '../school-shell/privacy';
import { useLocale } from '../localization/provider';
import { trainAiCopy, type TrainAiCopy } from './copy';
import {
  TrainAiAccessError, TrainAiRefusal, commandAttempt, loadKnowledge, loadTestChat, loadTrainAi, loadTrainingFile, mediaTypeFor, saveSettings, saveTrainingItem,
  setTrainingItemStatus, toBase64, uploadTrainingFile, type TrainAiScope,
} from './http';
import { setupCopy } from './setup-copy';
import { TryIt } from './try-it';
import { tryItCopy } from './try-it-copy';
import { enabledFromModes, modeSummary, modesAll, quickStartLeft, setupChecklist, type QuickStartKey } from './setup-model';
import { Checklist, HandoffChips, LengthPresets, ModeChoice, StatusCard, type StepKey } from './setup-parts';
import s from './setup.module.css';

type Attempt = { fingerprint: string; key: string } | null;
type SettingsDraft = Omit<ConversationAiSettingsInput, 'expectedVersion' | 'handoffWords' | 'afterHoursText'> & { handoffText: string; afterHoursText: string };
type ItemDraft = { itemId?: string; expectedVersion?: number; kind: ConversationAiItemKind; title: string; question: string; body: string; staffNote: string; summary: string; fileId?: string; fileName?: string };
const EMPTY_ITEM: ItemDraft = { kind: 'FAQ', title: '', question: '', body: '', staffNote: '', summary: '' };
const newKey = () => crypto.randomUUID();

function message(problem: unknown, copy: TrainAiCopy): string {
  if (problem instanceof TrainAiAccessError) return problem.reason === 'SESSION' ? copy.sessionEnded : copy.denied;
  if (problem instanceof TrainAiRefusal) return copy.refusal[problem.code] ?? copy.unavailable;
  return copy.unavailable;
}
function settingsDraft(overview: ConversationAiOverview): SettingsDraft {
  const st = overview.settings;
  return { enabled: st.enabled, modes: { ...st.modes }, handoffText: st.handoffWords.join(', '), afterHoursText: st.afterHoursText ?? '',
    smsMaxChars: st.smsMaxChars, chatMaxChars: st.chatMaxChars, languages: [...st.languages] };
}
/** The settings the server will accept, or null when a field is out of range (the save button stays off). */
export function settingsInput(draft: SettingsDraft, version: number): ConversationAiSettingsInput | null {
  const handoffWords = draft.handoffText.split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  const after = draft.afterHoursText.trim();
  if (!conversationAiHandoffWordsOk(handoffWords) || (after && !conversationAiTextOk(after, CONVERSATION_AI_LIMITS.afterHours))) return null;
  if (![draft.smsMaxChars, draft.chatMaxChars].every(n => Number.isInteger(n) && n >= 160 && n <= 1600) || draft.languages.length === 0) return null;
  return { expectedVersion: version, enabled: enabledFromModes(draft.modes), modes: draft.modes, handoffWords, afterHoursText: after || null,
    smsMaxChars: draft.smsMaxChars, chatMaxChars: draft.chatMaxChars, languages: draft.languages };
}
/** The item the server will accept, or null. Questions only for FAQs and coaching cards; a coach's note only on coaching cards. */
export function itemInput(draft: ItemDraft): ConversationAiItemInput | null {
  const title = draft.title.trim(), body = draft.body.trim(), question = draft.question.trim(), note = draft.staffNote.trim(), summary = draft.summary.trim();
  const asks = draft.kind === 'FAQ' || draft.kind === 'COACHING';
  if (!title || title.length > CONVERSATION_AI_LIMITS.title || !conversationAiTextOk(body, CONVERSATION_AI_LIMITS.body)) return null;
  if (asks && !conversationAiTextOk(question, CONVERSATION_AI_LIMITS.question)) return null;
  const out: ConversationAiItemInput = { kind: draft.kind, title, body };
  if (draft.itemId && draft.expectedVersion) { out.itemId = draft.itemId; out.expectedVersion = draft.expectedVersion; }
  if (asks) out.question = question;
  if (draft.kind === 'COACHING' && note) { if (!conversationAiTextOk(note, CONVERSATION_AI_LIMITS.staffNote)) return null; out.staffNote = note; }
  if (summary) { if (!conversationAiTextOk(summary, CONVERSATION_AI_LIMITS.summary)) return null; out.summary = summary; }
  if (draft.fileId && (draft.kind === 'DOCUMENT' || draft.kind === 'IMAGE')) out.fileId = draft.fileId;
  return out;
}

type Tab = 'how' | 'knows' | 'handoff' | 'tryIt';
const TABS: readonly Tab[] = ['how', 'knows', 'handoff', 'tryIt'];

/**
 * CE1 Conversation AI easy setup over the 0420 Train AI API (docs/architecture/CONVERSATION_AI_EASY_SETUP.md). Every call carries the shell's school scope, which the server re-checks (conversation.read to look,
 * conversation.ai.configure to change). Nothing here calls an AI: the library and settings are what a later AI turn reads.
 */
export function TrainAi(): React.ReactElement {
  const shell = useSchoolShell();
  const { preferences, date } = useLocale();
  const copy = trainAiCopy(preferences.language), easy = setupCopy(preferences.language), tryCopy = tryItCopy(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [overview, setOverview] = useState<ConversationAiOverview | null>(null), [knowledge, setKnowledge] = useState<ConversationAiKnowledge | null>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null), [item, setItem] = useState<ItemDraft>(EMPTY_ITEM), [filter, setFilter] = useState<ConversationAiItemKind | 'ALL'>('ALL');
  const [upload, setUpload] = useState<ConversationAiUploadReceipt | null>(null), [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false);
  const [tab, setTab] = useState<Tab>('how'), [perChannel, setPerChannel] = useState(false), [editing, setEditing] = useState(false), [showAll, setShowAll] = useState(false);
  const [tested, setTested] = useState(false);
  const [quick, setQuick] = useState<QuickStartKey | null>(null), [quickAnswer, setQuickAnswer] = useState(''), [rule, setRule] = useState('');
  const generation = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  // One retry key per command kind: an unconfirmed change keeps its key until the same change is sent again or something else is chosen.
  const attempts = useRef<Record<'settings' | 'item' | 'status' | 'upload', Attempt>>({ settings: null, item: null, status: null, upload: null });

  const scopeOf = useCallback((): TrainAiScope | null => {
    const [organizationId, schoolId] = scopeKey.split('/');
    return organizationId && schoolId ? { organizationId, schoolId } : null;
  }, [scopeKey]);
  const clear = useCallback(() => {
    ++generation.current; setOverview(null); setKnowledge(null); setTested(false); setSettings(null); setItem(EMPTY_ITEM); setUpload(null); setConfirming(null);
    attempts.current = { settings: null, item: null, status: null, upload: null };
  }, []);
  const refresh = useCallback(async () => {
    const scope = scopeOf();
    if (!scope) return;
    const token = ++generation.current;
    setBusy(true); setDenied(false);
    try {
      const next = await loadTrainAi(scope);
      if (generation.current !== token) return;
      setOverview(next); setSettings(settingsDraft(next)); setKnowledge(null); setError(''); setHidden(false);
      if (modeSummary(next.settings.modes) === 'MIXED') setPerChannel(true);
      // The checklist's last step: has this staff member seen an answer yet? A failure here only leaves it unticked.
      if (next.canConfigure) void loadTestChat(scope).then(state => { if (generation.current === token) setTested(state.tests.some(t => t.status === 'ANSWERED')); }, () => {});
    } catch (problem) {
      if (generation.current !== token) return;
      setOverview(null); setError(message(problem, copy)); setDenied(problem instanceof TrainAiAccessError);
    } finally { if (generation.current === token) setBusy(false); }
  }, [scopeOf, copy]);
  useEffect(() => { clear(); void refresh(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps -- reload on a new school only
  useEffect(() => onShellPrivacyEvent(() => { clear(); setError(''); setNotice(''); setHidden(true); }), [clear]);

  async function run(kind: keyof typeof attempts.current, fingerprint: string, action: (scope: TrainAiScope, key: string) => Promise<unknown>, done: string): Promise<boolean> {
    const scope = scopeOf();
    if (!scope || acting) return false;
    const attempt = commandAttempt(fingerprint, attempts.current[kind], newKey);
    attempts.current[kind] = attempt;
    const token = generation.current;
    setActing(true); setError(''); setNotice('');
    try {
      await action(scope, attempt.key);
      if (generation.current !== token) return false;
      attempts.current[kind] = null; setNotice(done);
      return true;
    } catch (problem) {
      if (generation.current !== token) return false;
      // A definite answer ends the command; an unknown one keeps the key so the same change is not saved twice.
      if (problem instanceof TrainAiRefusal || problem instanceof TrainAiAccessError) { attempts.current[kind] = null; setError(message(problem, copy)); }
      else setError(copy.unknownSave);
      return false;
    } finally { if (generation.current === token) setActing(false); }
  }

  async function saveAllSettings(event: React.FormEvent) {
    event.preventDefault();
    if (!overview || !settings) return;
    const input = settingsInput(settings, overview.settings.version);
    if (!input) { setError(copy.settingsInvalid); return; }
    if (await run('settings', `settings:${JSON.stringify(input)}`, (scope, key) => saveSettings(scope, input, key), copy.settingsSaved)) await refresh();
  }
  async function saveItem(event: React.FormEvent) {
    event.preventDefault();
    const input = itemInput(item);
    if (!input) { setError(copy.itemInvalid); return; }
    if (await run('item', `item:${JSON.stringify(input)}`, (scope, key) => saveTrainingItem(scope, input, key), copy.saved)) { setItem(EMPTY_ITEM); setUpload(null); setEditing(false); await refresh(); }
  }
  async function status(row: ConversationAiItem, next: 'ACTIVE' | 'PAUSED' | 'DELETED', done: string) {
    const input = { itemId: row.itemId, expectedVersion: row.version, status: next } as const;
    setConfirming(null);
    if (await run('status', `status:${JSON.stringify(input)}`, (scope, key) => setTrainingItemStatus(scope, input, key), done)) await refresh();
  }
  async function sendFile(event: React.FormEvent) {
    event.preventDefault();
    const file = fileInput.current?.files?.[0];
    if (!file) return;
    const mediaType = mediaTypeFor(file.name);
    if (!mediaType) { setError(copy.fileType); return; }
    if (file.size > CONVERSATION_AI_LIMITS.fileBytes) { setError(copy.fileTooBig); return; }
    const contentBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
    const input = { fileName: file.name, mediaType, contentBase64 };
    let receipt: ConversationAiUploadReceipt | null = null;
    const ok = await run('upload', `upload:${file.name}:${file.size}:${contentBase64.length}:${contentBase64.slice(0, 64)}`,
      async (scope, key) => { receipt = (await uploadTrainingFile(scope, input, key)).receipt; }, copy.uploaded(file.name));
    if (ok && receipt) {
      const r: ConversationAiUploadReceipt = receipt;
      setUpload(r);
      const kind: ConversationAiItemKind = r.file.mediaType.startsWith('image/') ? 'IMAGE' : 'DOCUMENT';
      setEditing(true);
      setItem({ ...EMPTY_ITEM, kind, title: r.file.fileName.replace(/\.[^.]+$/, '').slice(0, CONVERSATION_AI_LIMITS.title), body: r.extractedText ?? '', fileId: r.file.fileId, fileName: r.file.fileName });
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function openFile(fileId: string) {
    const scope = scopeOf();
    if (!scope) return;
    try {
      const file = await loadTrainingFile(scope, fileId);
      const bytes = Uint8Array.from(atob(file.contentBase64), c => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: file.mediaType }));
      const link = document.createElement('a');
      link.href = url; link.download = file.fileName; link.rel = 'noopener'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (problem) { setError(message(problem, copy)); }
  }
  async function showKnowledge() {
    const scope = scopeOf();
    if (!scope) return;
    const token = generation.current;
    try { const next = await loadKnowledge(scope); if (generation.current === token) setKnowledge(next); }
    catch (problem) { if (generation.current === token) setError(message(problem, copy)); }
  }

  async function addQuick(event: React.FormEvent) {
    event.preventDefault();
    if (!quick) return;
    const question = easy.quickStart[quick];
    const input = itemInput({ ...EMPTY_ITEM, kind: 'FAQ', title: question.slice(0, CONVERSATION_AI_LIMITS.title), question, body: quickAnswer });
    if (!input) { setError(copy.itemInvalid); return; }
    if (await run('item', `item:${JSON.stringify(input)}`, (scope, key) => saveTrainingItem(scope, input, key), copy.saved)) { setQuick(null); setQuickAnswer(''); await refresh(); }
  }
  async function addRule(event: React.FormEvent) {
    event.preventDefault();
    const text = rule.trim();
    const title = (text.split('\n')[0] ?? '').slice(0, 60).trim();
    const input = itemInput({ ...EMPTY_ITEM, kind: 'INSTRUCTION', title, body: text });
    if (!input) { setError(copy.itemInvalid); return; }
    if (await run('item', `item:${JSON.stringify(input)}`, (scope, key) => saveTrainingItem(scope, input, key), copy.saved)) { setRule(''); await refresh(); }
  }
  /** "Use a better answer": a coaching card (the question and the answer it should give), saved like any other item. */
  async function coach(question: string, answer: string): Promise<boolean> {
    const input = itemInput({ ...EMPTY_ITEM, kind: 'COACHING', title: question.slice(0, CONVERSATION_AI_LIMITS.title).trim(), question, body: answer });
    if (!input) { setError(copy.itemInvalid); return false; }
    const ok = await run('item', `item:${JSON.stringify(input)}`, (scope, key) => saveTrainingItem(scope, input, key), copy.saved);
    if (ok) await refresh();
    return ok;
  }
  function go(step: StepKey) {
    const next: Tab = step === 'answers' ? 'knows' : step === 'handoff' ? 'handoff' : step === 'tryIt' ? 'tryIt' : 'how';
    setTab(next);
    if (next === 'knows' && !knowledge) void showKnowledge();
  }
  function openTab(next: Tab) { setTab(next); if (next === 'knows' && !knowledge) void showKnowledge(); }
  function startEdit(row: ConversationAiItem) {
    setEditing(true);
    setItem({ itemId: row.itemId, expectedVersion: row.version, kind: row.kind, title: row.title, question: row.question ?? '', body: row.body, staffNote: row.staffNote ?? '',
      summary: row.summary ?? '', ...(row.file ? { fileId: row.file.fileId, fileName: row.file.fileName } : {}) });
  }

  if (!selection) return <main className={s.page}><header className={s.head}><h1>{easy.title}</h1></header><p className={s.meta}>{copy.chooseSchool}</p></main>;
  const canConfigure = overview?.canConfigure === true;
  const asks = item.kind === 'FAQ' || item.kind === 'COACHING';
  const locked = !canConfigure || acting;
  const saved = overview ? settingsDraft(overview) : null;
  const dirty = Boolean(settings && saved && JSON.stringify(settings) !== JSON.stringify(saved));
  const summary = settings ? modeSummary(settings.modes) : 'OFF';
  const answers = overview ? overview.items.filter(i => i.kind === 'FAQ' || i.kind === 'COACHING') : [];
  const rules = overview ? overview.items.filter(i => i.kind === 'INSTRUCTION') : [];
  const files = overview ? overview.items.filter(i => i.kind === 'DOCUMENT' || i.kind === 'IMAGE') : [];
  const left = overview ? quickStartLeft(overview.items, easy.quickStart) : [];

  const itemCard = (row: ConversationAiItem) => <li key={row.itemId} className={s.item} data-off={row.status !== 'ACTIVE'}>
    <div>{row.question ? <p className={s.itemQ}>{row.question}</p> : <p className={s.itemQ}>{row.title}</p>}
      <p className={s.itemA}>{row.body.length > 280 ? `${row.body.slice(0, 280)}…` : row.body}</p>
      {row.staffNote && <p className={s.meta}>{copy.staffNote}: {row.staffNote}</p>}
      <p className={s.meta}>{copy.kind[row.kind]} · {date(row.updatedAt)}{row.updatedBy ? ` · ${row.updatedBy}` : ''}</p></div>
    <button type="button" role="switch" className={s.switch} aria-checked={row.status === 'ACTIVE'} aria-label={easy.switchLabel(row.title)} disabled={locked}
      onClick={() => void status(row, row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE', row.status === 'ACTIVE' ? copy.paused_ : copy.resumed)}>
      {row.status === 'ACTIVE' ? easy.on : easy.off}</button>
    <div className={s.itemActions}>
      {row.file && <button type="button" className={s.ghost} onClick={() => void openFile(row.file!.fileId)}>{copy.openFile}</button>}
      {canConfigure && <>
        <button type="button" className={s.ghost} disabled={acting} onClick={() => startEdit(row)}>{copy.edit}</button>
        {confirming === row.itemId
          ? <><span className={s.meta}>{copy.removeConfirm(row.title)}</span>
            <button type="button" className={`${s.secondary} ${s.danger}`} disabled={acting} onClick={() => void status(row, 'DELETED', copy.removed)}>{copy.remove}</button>
            <button type="button" className={s.ghost} onClick={() => setConfirming(null)}>{copy.cancel}</button></>
          : <button type="button" className={`${s.ghost} ${s.danger}`} disabled={acting} onClick={() => setConfirming(row.itemId)}>{copy.remove}</button>}
      </>}
    </div>
  </li>;

  const editor = canConfigure && editing && <section className={s.card} aria-labelledby="ca-item"><h3 id="ca-item">{item.itemId ? copy.editTitle(item.title) : copy.addTitle}</h3>
    <form className={s.form} onSubmit={e => void saveItem(e)}>
      <div className={s.field}><label htmlFor="ca-kind">{copy.kindLabel}</label>
        <select id="ca-kind" value={item.kind} disabled={acting || Boolean(item.itemId)} onChange={e => setItem({ ...item, kind: e.target.value as ConversationAiItemKind })}>
          {CONVERSATION_AI_ITEM_KINDS.filter(k => item.fileId ? (k === 'DOCUMENT' || k === 'IMAGE') : true).map(k => <option key={k} value={k}>{copy.kind[k]}</option>)}</select></div>
      {item.fileName && <p className={s.meta}>{copy.chooseFile}: {item.fileName}</p>}
      <div className={s.field}><label htmlFor="ca-title">{copy.itemTitle}</label>
        <input id="ca-title" value={item.title} maxLength={CONVERSATION_AI_LIMITS.title} disabled={acting} onChange={e => setItem({ ...item, title: e.target.value })} /></div>
      {asks && <div className={s.field}><label htmlFor="ca-question">{copy.question}</label>
        <input id="ca-question" value={item.question} maxLength={CONVERSATION_AI_LIMITS.question} disabled={acting} placeholder={copy.questionHint} onChange={e => setItem({ ...item, question: e.target.value })} /></div>}
      <div className={s.field}><label htmlFor="ca-body">{asks ? copy.answer : copy.body}</label>
        <textarea id="ca-body" rows={5} value={item.body} maxLength={CONVERSATION_AI_LIMITS.body} disabled={acting} onChange={e => setItem({ ...item, body: e.target.value })} /></div>
      <div className={s.field}><label htmlFor="ca-summary">{copy.summary}</label>
        <input id="ca-summary" value={item.summary} maxLength={CONVERSATION_AI_LIMITS.summary} disabled={acting} onChange={e => setItem({ ...item, summary: e.target.value })} /></div>
      {item.kind === 'COACHING' && <div className={s.field}><label htmlFor="ca-note">{copy.staffNote}</label>
        <input id="ca-note" value={item.staffNote} maxLength={CONVERSATION_AI_LIMITS.staffNote} disabled={acting} placeholder={copy.staffNoteHint} onChange={e => setItem({ ...item, staffNote: e.target.value })} /></div>}
      <div className={s.actions}><button type="submit" className={s.primary} disabled={acting || !itemInput(item)}>{copy.save}</button>
        <button type="button" className={s.ghost} disabled={acting} onClick={() => { setItem(EMPTY_ITEM); setUpload(null); setEditing(false); }}>{copy.cancel}</button></div>
    </form>
    {upload && !upload.extractedText && <p className={s.meta}>{copy.noText}</p>}
  </section>;

  return <main className={s.page}>
    <header className={s.head}><p className={s.eyebrow}>{easy.eyebrow}</p><h1>{easy.title}</h1><p className={s.intro}>{easy.intro}</p></header>
    {hidden && !overview && <p className={s.actions}><span className={s.meta}>{copy.hidden}</span> <button type="button" className={s.secondary} onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !overview && <p role="status" className={s.meta}>{copy.loading}</p>}
      {error && <div className={s.flash} data-tone="ERROR" role="alert"><strong>{denied ? copy.deniedTitle : easy.title}</strong> {error}</div>}
      {notice && <p className={s.flash} data-tone="OK" role="status">{notice}</p>}</div>
    {overview && settings && <>
      <StatusCard copy={easy} program={overview.program} summary={modeSummary(overview.settings.modes)} />
      <Checklist copy={easy} state={setupChecklist(overview, tested)} onGo={go} />
      {!canConfigure && <p className={s.meta}>{easy.readOnly}</p>}

      <div className={s.tabs} role="tablist" aria-label={easy.tabsLabel}>
        {TABS.map(t => <button key={t} type="button" role="tab" id={`ca-tab-${t}`} aria-controls={`ca-panel-${t}`} aria-selected={tab === t} onClick={() => openTab(t)}>{easy.tabs[t]}</button>)}
      </div>

      {tab === 'how' && <div role="tabpanel" id="ca-panel-how" aria-labelledby="ca-tab-how" className={s.page}>
        <section className={s.card}>
          <ModeChoice copy={easy} value={perChannel ? 'MIXED' : summary} disabled={locked}
            onChoose={mode => { setSettings({ ...settings, modes: modesAll(mode) }); setPerChannel(false); }} />
          <div className={s.actions}><button type="button" className={s.ghost} aria-expanded={perChannel} onClick={() => setPerChannel(!perChannel)}>{perChannel ? easy.perChannelHide : easy.perChannel}</button>
            {summary === 'MIXED' && <span className={s.meta}>{easy.mixed}</span>}</div>
          {perChannel && CONVERSATION_AI_CHANNELS.map(channel => <div key={channel} className={s.channelRow}><span className={s.channelName}>{copy.channel[channel]}</span>
            <div className={s.segment} role="group" aria-label={copy.channel[channel]}>
              {CONVERSATION_AI_MODES.map(mode => <button key={mode} type="button" aria-pressed={settings.modes[channel] === mode} disabled={locked}
                onClick={() => setSettings({ ...settings, modes: { ...settings.modes, [channel]: mode } })}>{easy.choice[mode].title}</button>)}
            </div></div>)}
        </section>
        <section className={s.card} aria-labelledby="ca-languages"><h2 id="ca-languages">{easy.languages}</h2><p className={s.meta}>{easy.languagesHint}</p>
          <div className={s.actions}>{CONVERSATION_AI_LANGUAGES.map((language: ConversationAiLanguage) => <button key={language} type="button" className={s.toggleChip}
            aria-pressed={settings.languages.includes(language)} disabled={locked || (settings.languages.length === 1 && settings.languages.includes(language))}
            onClick={() => setSettings({ ...settings, languages: settings.languages.includes(language) ? settings.languages.filter(l => l !== language)
              : CONVERSATION_AI_LANGUAGES.filter(l => l === language || settings.languages.includes(l)) })}>{copy.language[language]}</button>)}</div>
        </section>
      </div>}

      {tab === 'knows' && <div role="tabpanel" id="ca-panel-knows" aria-labelledby="ca-tab-knows" className={s.page}>
        {canConfigure && <section className={s.card} aria-labelledby="ca-quick"><h2 id="ca-quick">{easy.quickTitle}</h2>
          {left.length === 0 ? <p className={s.meta}>{easy.quickDone}</p> : <><p className={s.meta}>{easy.quickIntro}</p>
            <ul className={s.quick}>{left.map(k => <li key={k}><button type="button" aria-pressed={quick === k} disabled={acting} onClick={() => { setQuick(quick === k ? null : k); setQuickAnswer(''); }}>{easy.quickStart[k]}</button></li>)}</ul></>}
          {quick && <form className={s.form} onSubmit={e => void addQuick(e)}>
            <div className={s.field}><label htmlFor="ca-quick-answer">{easy.answerFor(easy.quickStart[quick])}</label>
              <textarea id="ca-quick-answer" rows={3} value={quickAnswer} maxLength={CONVERSATION_AI_LIMITS.body} placeholder={easy.answerPlaceholder} disabled={acting} onChange={e => setQuickAnswer(e.target.value)} /></div>
            <div className={s.actions}><button type="submit" className={s.primary} disabled={acting || !conversationAiTextOk(quickAnswer.trim(), CONVERSATION_AI_LIMITS.body)}>{easy.addAnswer}</button>
              <button type="button" className={s.ghost} onClick={() => setQuick(null)}>{copy.cancel}</button></div>
          </form>}
        </section>}
        {editor}
        <section className={s.card} aria-labelledby="ca-answers"><div className={s.actions}><h2 id="ca-answers">{easy.answersTitle}</h2>
          {canConfigure && <button type="button" className={s.secondary} disabled={acting} onClick={() => { setItem(EMPTY_ITEM); setUpload(null); setEditing(true); }}>{easy.addOwn}</button>}</div>
          {answers.length === 0 ? <p className={s.meta}>{easy.answersEmpty}</p> : <ul className={s.items}>{answers.map(itemCard)}</ul>}
        </section>
        <section className={s.card} aria-labelledby="ca-rules"><h2 id="ca-rules">{easy.rulesTitle}</h2><p className={s.meta}>{easy.rulesIntro}</p>
          {rules.length > 0 && <ul className={s.items}>{rules.map(itemCard)}</ul>}
          {canConfigure && <form className={s.inline} onSubmit={e => void addRule(e)}>
            <input aria-label={easy.rulesTitle} placeholder={easy.ruleExample} value={rule} maxLength={CONVERSATION_AI_LIMITS.body} disabled={acting} onChange={e => setRule(e.target.value)} />
            <button type="submit" className={s.secondary} disabled={acting || !rule.trim()}>{easy.addRule}</button></form>}
        </section>
        <section className={s.card} aria-labelledby="ca-files"><h2 id="ca-files">{easy.filesTitle}</h2><p className={s.meta}>{easy.filesIntro}</p>
          {files.length > 0 && <ul className={s.items}>{files.map(itemCard)}</ul>}
          {canConfigure && <form className={s.inline} onSubmit={e => void sendFile(e)}>
            <input id="ca-file" ref={fileInput} type="file" accept=".txt,.csv,.md,.pdf,.docx,.png,.jpg,.jpeg,.webp" disabled={acting} aria-label={copy.chooseFile} aria-describedby="ca-file-hint" />
            <button type="submit" className={s.secondary} disabled={acting}>{acting ? copy.uploading : copy.upload}</button></form>}
          {canConfigure && <p id="ca-file-hint" className={s.meta}>{copy.uploadHint}</p>}
        </section>
        <section className={s.card} aria-labelledby="ca-also"><h2 id="ca-also">{copy.knowledgeTitle}</h2>
          {knowledge ? <p className={s.meta}>{easy.alsoReads(knowledge.plans.length, knowledge.bookingTypes.length, knowledge.articles.length)}</p>
            : <p className={s.meta}>{copy.knowledgeIntro}</p>}
          <div className={s.actions}><button type="button" className={s.ghost} aria-expanded={showAll} onClick={() => { if (!knowledge) void showKnowledge(); setShowAll(!showAll); }}>{easy.showAlso}</button></div>
          {showAll && knowledge && <div className={s.knowledge}>
            <p><strong>{copy.tone}:</strong> {knowledge.tone || copy.nothing} · <strong>{copy.languages}:</strong> {knowledge.languages.map(l => copy.language[l]).join(', ')}</p>
            <h4>{copy.instructions}</h4>{knowledge.instructions.length ? <ul>{knowledge.instructions.map((x, i) => <li key={i}>{x.text}</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
            <h4>{copy.faqs}</h4>{knowledge.faqs.length ? <ul>{knowledge.faqs.map((x, i) => <li key={i}><em>{x.question}</em> {x.answer}</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
            <h4>{copy.documents}</h4>{knowledge.documents.length ? <ul>{knowledge.documents.map((x, i) => <li key={i}><strong>{x.title}</strong>: {x.text.slice(0, 300)}</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
            <h4>{copy.articles}</h4>{knowledge.articles.length ? <ul>{knowledge.articles.map((x, i) => <li key={i}><strong>{x.title}</strong>: {x.text.slice(0, 300)}</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
            <h4>{copy.plans}</h4>{knowledge.plans.length ? <ul>{knowledge.plans.map((x, i) => <li key={i}>{x.name}</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
            <h4>{copy.bookingTypes}</h4>{knowledge.bookingTypes.length ? <ul>{knowledge.bookingTypes.map((x, i) => <li key={i}>{x.name} · {x.durationMinutes} min</li>)}</ul> : <p className={s.meta}>{copy.nothing}</p>}
          </div>}
        </section>
      </div>}

      {tab === 'handoff' && <div role="tabpanel" id="ca-panel-handoff" aria-labelledby="ca-tab-handoff" className={s.page}>
        <section className={s.card} aria-labelledby="ca-words"><h2 id="ca-words">{easy.handoffTitle}</h2><p className={s.meta}>{easy.handoffIntro}</p>
          <HandoffChips copy={easy} text={settings.handoffText} disabled={locked} onChange={handoffText => setSettings({ ...settings, handoffText })} /></section>
        <section className={s.card} aria-labelledby="ca-after"><h2 id="ca-after">{easy.afterHoursTitle}</h2><p className={s.meta}>{easy.afterHoursIntro}</p>
          <textarea aria-labelledby="ca-after" rows={2} maxLength={CONVERSATION_AI_LIMITS.afterHours} value={settings.afterHoursText} placeholder={easy.afterHoursExample} disabled={locked}
            onChange={e => setSettings({ ...settings, afterHoursText: e.target.value })} /></section>
        <section className={s.card} aria-labelledby="ca-length"><h2 id="ca-length">{easy.lengthTitle}</h2><p className={s.meta}>{easy.lengthIntro}</p>
          <LengthPresets copy={easy} label={easy.lengthTexts} value={settings.smsMaxChars} disabled={locked} onChange={smsMaxChars => setSettings({ ...settings, smsMaxChars })} />
          <LengthPresets copy={easy} label={easy.lengthChat} value={settings.chatMaxChars} disabled={locked} onChange={chatMaxChars => setSettings({ ...settings, chatMaxChars })} /></section>
      </div>}

      {tab === 'tryIt' && <div role="tabpanel" id="ca-panel-tryIt" aria-labelledby="ca-tab-tryIt" className={s.page}>
        <TryIt scope={{ organizationId: selection.organizationId, schoolId: selection.schoolId }} copy={tryCopy} canConfigure={canConfigure}
          samples={Object.values(easy.quickStart)} onAnswered={answered => { if (answered) setTested(true); }} onCoach={coach} />
      </div>}

      {canConfigure && dirty && <form className={s.saveBar} onSubmit={e => void saveAllSettings(e)}><p>{easy.unsaved}</p>
        <div className={s.actions}><button type="button" className={s.ghost} disabled={acting} onClick={() => saved && setSettings(saved)}>{easy.discard}</button>
          <button type="submit" className={s.primary} disabled={acting || !settingsInput(settings, overview.settings.version)}>{acting ? easy.saving : easy.save}</button></div></form>}
    </>}
  </main>;
}
