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
  TrainAiAccessError, TrainAiRefusal, commandAttempt, loadKnowledge, loadTrainAi, loadTrainingFile, mediaTypeFor, saveSettings, saveTrainingItem,
  setTrainingItemStatus, toBase64, uploadTrainingFile, type TrainAiScope,
} from './http';
import s from '../testing-registration.module.css';

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
  return { expectedVersion: version, enabled: draft.enabled, modes: draft.modes, handoffWords, afterHoursText: after || null,
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

/**
 * 0365 Train AI. Every call carries the shell's school scope, which the server re-checks (conversation.read to look,
 * conversation.ai.configure to change). Nothing here calls an AI: the library and settings are what a later AI turn reads.
 */
export function TrainAi(): React.ReactElement {
  const shell = useSchoolShell();
  const { preferences, date } = useLocale();
  const copy = trainAiCopy(preferences.language);
  const selection = shell.phase === 'READY' ? shell.selection : null;
  const scopeKey = selection ? `${selection.organizationId}/${selection.schoolId}` : '';
  const [overview, setOverview] = useState<ConversationAiOverview | null>(null), [knowledge, setKnowledge] = useState<ConversationAiKnowledge | null>(null);
  const [settings, setSettings] = useState<SettingsDraft | null>(null), [item, setItem] = useState<ItemDraft>(EMPTY_ITEM), [filter, setFilter] = useState<ConversationAiItemKind | 'ALL'>('ALL');
  const [upload, setUpload] = useState<ConversationAiUploadReceipt | null>(null), [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [acting, setActing] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [denied, setDenied] = useState(false), [hidden, setHidden] = useState(false);
  const generation = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  // One retry key per command kind: an unconfirmed change keeps its key until the same change is sent again or something else is chosen.
  const attempts = useRef<Record<'settings' | 'item' | 'status' | 'upload', Attempt>>({ settings: null, item: null, status: null, upload: null });

  const scopeOf = useCallback((): TrainAiScope | null => {
    const [organizationId, schoolId] = scopeKey.split('/');
    return organizationId && schoolId ? { organizationId, schoolId } : null;
  }, [scopeKey]);
  const clear = useCallback(() => {
    ++generation.current; setOverview(null); setKnowledge(null); setSettings(null); setItem(EMPTY_ITEM); setUpload(null); setConfirming(null);
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
    if (await run('item', `item:${JSON.stringify(input)}`, (scope, key) => saveTrainingItem(scope, input, key), copy.saved)) { setItem(EMPTY_ITEM); setUpload(null); await refresh(); }
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

  if (!selection) return <main className={s.page}><div className={s.shell}><header className={s.header}><h1>{copy.title}</h1></header><p>{copy.chooseSchool}</p></div></main>;
  const canConfigure = overview?.canConfigure === true;
  const items = overview ? overview.items.filter(i => filter === 'ALL' || i.kind === filter) : [];
  const asks = item.kind === 'FAQ' || item.kind === 'COACHING';
  const lockedInputs = !canConfigure || acting;
  return <main className={s.page}><div className={s.shell}>
    <header className={s.header}><h1>{copy.title}</h1><p>{copy.intro}</p><p className={s.subtle}>{copy.noAiYet}</p></header>
    {hidden && !overview && <p className={s.actions}><span className={s.subtle}>{copy.hidden}</span> <button type="button" onClick={() => void refresh()}>{copy.show}</button></p>}
    <div aria-live="polite">{busy && !overview && <p role="status">{copy.loading}</p>}
      {error && <div className={s.error} role="alert"><strong>{denied ? copy.deniedTitle : copy.title}</strong><p>{error}</p></div>}
      {notice && <p className={s.notice} role="status">{notice}</p>}</div>
    {overview && settings && <>
      <p><strong>{copy.programLabel}:</strong> {copy.program[overview.program]} <button type="button" disabled={busy} onClick={() => void refresh()}>{copy.refresh}</button></p>
      {!canConfigure && <p className={s.subtle}>{copy.readOnly}</p>}

      <section className={s.card} aria-labelledby="train-ai-settings"><h2 id="train-ai-settings">{copy.settingsTitle}</h2>
        <form onSubmit={e => void saveAllSettings(e)}>
          <label><input type="checkbox" checked={settings.enabled} disabled={lockedInputs} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> {copy.enabled}</label>
          <p className={s.subtle}>{copy.enabledHint}</p>
          <fieldset><legend>{copy.modesTitle}</legend>
            {CONVERSATION_AI_CHANNELS.map(channel => <label key={channel}>{copy.channel[channel]}{' '}
              <select value={settings.modes[channel]} disabled={lockedInputs} onChange={e => setSettings({ ...settings, modes: { ...settings.modes, [channel]: e.target.value as typeof CONVERSATION_AI_MODES[number] } })}>
                {CONVERSATION_AI_MODES.map(mode => <option key={mode} value={mode}>{copy.mode[mode]}</option>)}</select></label>)}
            <p className={s.subtle}>{copy.modeHint}</p></fieldset>
          <label htmlFor="train-ai-handoff">{copy.handoff}</label>
          <input id="train-ai-handoff" value={settings.handoffText} disabled={lockedInputs} aria-describedby="train-ai-handoff-hint" onChange={e => setSettings({ ...settings, handoffText: e.target.value })} />
          <p id="train-ai-handoff-hint" className={s.subtle}>{copy.handoffHint}</p>
          <label htmlFor="train-ai-after">{copy.afterHours}</label>
          <textarea id="train-ai-after" rows={2} maxLength={CONVERSATION_AI_LIMITS.afterHours} value={settings.afterHoursText} disabled={lockedInputs}
            aria-describedby="train-ai-after-hint" onChange={e => setSettings({ ...settings, afterHoursText: e.target.value })} />
          <p id="train-ai-after-hint" className={s.subtle}>{copy.afterHoursHint}</p>
          <p className={s.actions}>
            <label>{copy.smsMax} <input type="number" min={160} max={1600} value={settings.smsMaxChars} disabled={lockedInputs} onChange={e => setSettings({ ...settings, smsMaxChars: Number(e.target.value) })} /></label>
            <label>{copy.chatMax} <input type="number" min={160} max={1600} value={settings.chatMaxChars} disabled={lockedInputs} onChange={e => setSettings({ ...settings, chatMaxChars: Number(e.target.value) })} /></label>
            <span className={s.subtle}>{copy.maxHint}</span></p>
          <fieldset><legend>{copy.languages}</legend>
            {CONVERSATION_AI_LANGUAGES.map((language: ConversationAiLanguage) => <label key={language}><input type="checkbox" checked={settings.languages.includes(language)} disabled={lockedInputs}
              onChange={e => setSettings({ ...settings, languages: e.target.checked ? CONVERSATION_AI_LANGUAGES.filter(l => l === language || settings.languages.includes(l)) : settings.languages.filter(l => l !== language) })} /> {copy.language[language]}</label>)}
          </fieldset>
          {canConfigure && <p className={s.actions}><button type="submit" disabled={acting || !settingsInput(settings, overview.settings.version)}>{copy.saveSettings}</button></p>}
        </form>
      </section>

      <section className={s.card} aria-labelledby="train-ai-library"><h2 id="train-ai-library">{copy.libraryTitle}</h2>
        <p>{copy.libraryIntro} <span className={s.subtle}>{copy.count(overview.items.length, CONVERSATION_AI_LIMITS.items)}</span></p>
        <p className={s.actions} role="group" aria-label={copy.kindLabel}>
          {(['ALL', ...CONVERSATION_AI_ITEM_KINDS] as const).map(k => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{k === 'ALL' ? copy.allKinds : copy.kind[k]}</button>)}</p>
        {items.length === 0 ? <p className={s.empty}>{copy.libraryEmpty}</p> : <ul className={s.list}>{items.map(row => <li key={row.itemId}>
          <p><strong>{row.title}</strong> <span className={s.badge}>{copy.kind[row.kind]}</span> <span className={s.subtle}>· {row.status === 'ACTIVE' ? copy.active : copy.paused} · {date(row.updatedAt)}{row.updatedBy ? ` · ${row.updatedBy}` : ''}</span></p>
          {row.question && <p><em>{row.question}</em></p>}
          <p style={{ whiteSpace: 'pre-wrap' }}>{row.body.length > 400 ? `${row.body.slice(0, 400)}…` : row.body}</p>
          {row.staffNote && <p className={s.subtle}>{copy.staffNote}: {row.staffNote}</p>}
          <p className={s.actions}>
            {row.file && <button type="button" onClick={() => void openFile(row.file!.fileId)}>{copy.openFile}</button>}
            {canConfigure && <>
              <button type="button" disabled={acting} onClick={() => setItem({ itemId: row.itemId, expectedVersion: row.version, kind: row.kind, title: row.title, question: row.question ?? '',
                body: row.body, staffNote: row.staffNote ?? '', summary: row.summary ?? '', ...(row.file ? { fileId: row.file.fileId, fileName: row.file.fileName } : {}) })}>{copy.edit}</button>
              <button type="button" disabled={acting} onClick={() => void status(row, row.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE', row.status === 'ACTIVE' ? copy.paused_ : copy.resumed)}>
                {row.status === 'ACTIVE' ? copy.pause : copy.resume}</button>
              {confirming === row.itemId
                ? <><span>{copy.removeConfirm(row.title)}</span> <button type="button" disabled={acting} onClick={() => void status(row, 'DELETED', copy.removed)}>{copy.remove}</button>
                  <button type="button" onClick={() => setConfirming(null)}>{copy.cancel}</button></>
                : <button type="button" disabled={acting} onClick={() => setConfirming(row.itemId)}>{copy.remove}</button>}
            </>}
          </p>
        </li>)}</ul>}
      </section>

      {canConfigure && <section className={s.card} aria-labelledby="train-ai-upload"><h2 id="train-ai-upload">{copy.uploadTitle}</h2>
        <form onSubmit={e => void sendFile(e)}>
          <label htmlFor="train-ai-file">{copy.chooseFile}</label>
          <input id="train-ai-file" ref={fileInput} type="file" accept=".txt,.csv,.md,.pdf,.docx,.png,.jpg,.jpeg,.webp" disabled={acting} aria-describedby="train-ai-file-hint" />
          <p id="train-ai-file-hint" className={s.subtle}>{copy.uploadHint}</p>
          <p className={s.actions}><button type="submit" disabled={acting}>{acting ? copy.uploading : copy.upload}</button></p>
        </form>
        {upload && <div><h3>{copy.extracted}</h3>{upload.extractedText ? <p style={{ whiteSpace: 'pre-wrap' }}>{upload.extractedText.slice(0, 1200)}</p> : <p className={s.subtle}>{copy.noText}</p>}
          <p className={s.subtle}>{copy.addFromFile}</p></div>}
      </section>}

      {canConfigure && <section className={s.card} aria-labelledby="train-ai-item"><h2 id="train-ai-item">{item.itemId ? copy.editTitle(item.title) : copy.addTitle}</h2>
        <form onSubmit={e => void saveItem(e)}>
          <label htmlFor="train-ai-kind">{copy.kindLabel}</label>
          <select id="train-ai-kind" value={item.kind} disabled={acting || Boolean(item.itemId)} onChange={e => setItem({ ...item, kind: e.target.value as ConversationAiItemKind })}>
            {CONVERSATION_AI_ITEM_KINDS.filter(k => item.fileId ? (k === 'DOCUMENT' || k === 'IMAGE') : true).map(k => <option key={k} value={k}>{copy.kind[k]}</option>)}</select>
          {item.fileName && <p className={s.subtle}>{copy.chooseFile}: {item.fileName}</p>}
          <label htmlFor="train-ai-title">{copy.itemTitle}</label>
          <input id="train-ai-title" value={item.title} maxLength={CONVERSATION_AI_LIMITS.title} disabled={acting} onChange={e => setItem({ ...item, title: e.target.value })} />
          {asks && <><label htmlFor="train-ai-question">{copy.question}</label>
            <input id="train-ai-question" value={item.question} maxLength={CONVERSATION_AI_LIMITS.question} disabled={acting} aria-describedby="train-ai-question-hint" onChange={e => setItem({ ...item, question: e.target.value })} />
            <p id="train-ai-question-hint" className={s.subtle}>{copy.questionHint}</p></>}
          <label htmlFor="train-ai-body">{asks ? copy.answer : copy.body}</label>
          <textarea id="train-ai-body" rows={6} value={item.body} maxLength={CONVERSATION_AI_LIMITS.body} disabled={acting} onChange={e => setItem({ ...item, body: e.target.value })} />
          {item.kind === 'COACHING' && <><label htmlFor="train-ai-note">{copy.staffNote}</label>
            <input id="train-ai-note" value={item.staffNote} maxLength={CONVERSATION_AI_LIMITS.staffNote} disabled={acting} aria-describedby="train-ai-note-hint" onChange={e => setItem({ ...item, staffNote: e.target.value })} />
            <p id="train-ai-note-hint" className={s.subtle}>{copy.staffNoteHint}</p></>}
          <label htmlFor="train-ai-summary">{copy.summary}</label>
          <input id="train-ai-summary" value={item.summary} maxLength={CONVERSATION_AI_LIMITS.summary} disabled={acting} onChange={e => setItem({ ...item, summary: e.target.value })} />
          <p className={s.actions}><button type="submit" disabled={acting || !itemInput(item)}>{copy.save}</button>
            {(item.itemId || item.fileId) && <button type="button" disabled={acting} onClick={() => { setItem(EMPTY_ITEM); setUpload(null); }}>{copy.cancel}</button>}</p>
        </form>
      </section>}

      <section className={s.card} aria-labelledby="train-ai-knowledge"><h2 id="train-ai-knowledge">{copy.knowledgeTitle}</h2>
        <p>{copy.knowledgeIntro}</p>
        {!knowledge ? <p className={s.actions}><button type="button" onClick={() => void showKnowledge()}>{copy.showKnowledge}</button></p> : <>
          <p><strong>{copy.tone}:</strong> {knowledge.tone || copy.nothing} · <strong>{copy.languages}:</strong> {knowledge.languages.map(l => copy.language[l]).join(', ')}</p>
          <h3>{copy.instructions}</h3>{knowledge.instructions.length ? <ul>{knowledge.instructions.map((x, i) => <li key={i}>{x.text}</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
          <h3>{copy.faqs}</h3>{knowledge.faqs.length ? <ul>{knowledge.faqs.map((x, i) => <li key={i}><em>{x.question}</em> {x.answer}</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
          <h3>{copy.documents}</h3>{knowledge.documents.length ? <ul>{knowledge.documents.map((x, i) => <li key={i}><strong>{x.title}</strong>: {x.text.slice(0, 300)}</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
          <h3>{copy.articles}</h3>{knowledge.articles.length ? <ul>{knowledge.articles.map((x, i) => <li key={i}><strong>{x.title}</strong>: {x.text.slice(0, 300)}</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
          <h3>{copy.plans}</h3>{knowledge.plans.length ? <ul>{knowledge.plans.map((x, i) => <li key={i}>{x.name}</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
          <h3>{copy.bookingTypes}</h3>{knowledge.bookingTypes.length ? <ul>{knowledge.bookingTypes.map((x, i) => <li key={i}>{x.name} · {x.durationMinutes} min</li>)}</ul> : <p className={s.subtle}>{copy.nothing}</p>}
        </>}
      </section>
    </>}
  </div></main>;
}
