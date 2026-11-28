'use client';
import React, { useEffect, useRef, useState } from 'react';
import { DESIGN_DRAFT_LIMITS, type CreativeDesignSizeCode, type DesignDraftPrice, type DesignDraftView } from '@hon/contracts';
import { ALL_STYLE_FONTS, Preview } from './gallery';
import { loadDesignFonts } from './fonts';
import { DesignDraftError, draftLanguage, type DesignDraftApi } from './draft-http';
import { templateName, type Brand, type TemplateCopy, type TemplateId } from './templates';
import { templateWords } from './template-copy';
import type { DesignKey } from './copy';
import type { DesignsScope } from './http';
import s from './design-editor.module.css';

/**
 * E4a "Describe your design": the person writes what the design is for and Marcus answers with up to three options, each a
 * template and the words to put on it. Picking one only chooses it; the design is made by the form's own Create button, so
 * nothing is saved until then. When AI is off, not allowed or paused the box says so and sends nothing.
 */
export type AiChoice = Readonly<{ key: string; draftId: string; template: TemplateId; copy: TemplateCopy }>;

/** The options a recorded draft offers, ready to preview and create. Empty for any other outcome. */
export function draftChoices(view: DesignDraftView | null): AiChoice[] {
  if (!view?.draft || view.status !== 'RESULT_RECORDED') return [];
  return view.draft.options.map((o, i) => ({ key: `${view.id}:${i}`, draftId: view.id, template: `${o.theme}-${o.style}` as TemplateId,
    copy: { words: { ...o.words }, schedule: o.schedule } }));
}

/** Plain words for a draft that came back without options, or for a refused request; null when there is nothing to say. */
export function draftNoticeKey(outcome: DesignDraftView | DesignDraftError | null): DesignKey | null {
  if (!outcome) return null;
  if (outcome instanceof DesignDraftError) {
    if (outcome.code === 'SESSION') return 'session';
    if (outcome.code === 'DESIGN_DRAFT_FORBIDDEN' || outcome.code === 'DESIGN_DRAFT_SCOPE_DENIED') return 'aiForbidden';
    if (outcome.code === 'DESIGN_DRAFT_SPEND_STOPPED') return 'aiStopped';
    if (outcome.code === 'DESIGN_DRAFT_INVALID') return 'aiInvalid';
    if (outcome.code === 'DESIGN_DRAFT_CONFLICT') return 'aiBusy';
    if (outcome.code === 'DESIGN_DRAFT_PERSISTENCE_UNKNOWN') return 'aiUnknown';
    return 'aiFailed';
  }
  if (outcome.status === 'RESULT_RECORDED' && outcome.draft?.options.length) return null;
  if (outcome.status === 'CONFIGURATION_REQUIRED') return 'aiOff';
  if (outcome.status === 'BLOCKED') return outcome.reason === 'CREATIVE_CREDITS_EXHAUSTED' ? 'aiNoCredits' : outcome.reason === 'CREATIVE_EDIT_IN_PROGRESS' ? 'aiBusy' : 'aiStopped';
  if (outcome.status === 'RESULT_REJECTED') return 'aiRejected';
  if (outcome.status === 'FAILED') return 'aiFailed';
  return 'aiUnknown';
}

const newKey = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000');

export function DesignAiBox({ api, scope, code, language, brand, value, onPick, t }: Readonly<{
  api: DesignDraftApi; scope: DesignsScope; code: CreativeDesignSizeCode; language: string; brand: Brand; value: string | null;
  onPick: (choice: AiChoice | null) => void; t: (key: DesignKey, vars?: Record<string, string>) => string;
}>) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [price, setPrice] = useState<DesignDraftPrice | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DesignDraftView | DesignDraftError | null>(null);
  const [fontsReady, setFontsReady] = useState(0);
  // One key per request: kept while an answer is unknown so pressing Ask again replays it, renewed once the words change.
  const key = useRef(newKey());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setAvailable(null);
    void api.status(scope).then(st => { if (alive.current) { setAvailable(st.available); setPrice(st.price); } });
    return () => { alive.current = false; };
  }, [api, scope.organizationId, scope.schoolId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let on = true;
    void loadDesignFonts(ALL_STYLE_FONTS).then(ready => { if (on && ready.length) setFontsReady(n => n + 1); });
    return () => { on = false; };
  }, []);

  const ask = async () => {
    const brief = text.replace(/\s+/g, ' ').trim();
    if (!brief || busy || available !== true) return;
    setBusy(true); setOutcome(null); onPick(null);
    let result: DesignDraftView | DesignDraftError;
    try { result = await api.draft(scope, brief, code, draftLanguage(language), key.current); }
    catch (error) { result = error instanceof DesignDraftError ? error : new DesignDraftError('DESIGN_DRAFT_UNAVAILABLE'); }
    if (!alive.current) return;
    setBusy(false); setOutcome(result);
    // The balance moved (or the plan changed): read the price again. Best effort.
    void api.status(scope).then(st => { if (alive.current) setPrice(st.price); });
    // A settled answer frees the key; an unknown one keeps it so a retry replays instead of paying twice.
    const settled = !(result instanceof DesignDraftError) ? result.status !== 'SENDING' && result.status !== 'UNKNOWN'
      : !['DESIGN_DRAFT_CONFLICT', 'DESIGN_DRAFT_PERSISTENCE_UNKNOWN', 'DESIGN_DRAFT_UNAVAILABLE'].includes(result.code);
    if (settled) key.current = newKey();
  };

  const view = outcome instanceof DesignDraftError ? null : outcome;
  const choices = draftChoices(view);
  const notice = draftNoticeKey(outcome);
  const words = templateWords(language);
  return (
    <div className={s.aiBox} aria-label={t('aiTitle')} role="group">
      <strong>{t('aiTitle')}</strong>
      <span className={s.meta}>{t('aiIntro')}</span>
      <textarea name="designBrief" className={s.aiText} rows={3} value={text} maxLength={DESIGN_DRAFT_LIMITS.brief} placeholder={t('aiPlaceholder')}
        disabled={available !== true || busy} onChange={event => { setText(event.target.value); key.current = newKey(); }} />
      <div className={s.aiRow}>
        <button type="button" className={s.button} disabled={available !== true || busy || !text.trim()} onClick={() => void ask()}>{busy ? t('aiWorking') : t('aiAsk')}</button>
        <span className={s.meta}>{text.length}/{DESIGN_DRAFT_LIMITS.brief}</span>
      </div>
      {available === false ? <p className={s.meta} role="status">{t('aiOff')}</p> : null}
      {available && price ? <p className={s.meta}>{price.paidWith === 'CREATIVE_CREDITS'
        ? t('aiCost', { n: String(price.creditsPerDesign), left: String(price.availableCredits) }) : t('aiIncluded')}</p> : null}
      {notice ? <p className={s.notice} data-tone="warn" role="alert">{t(notice)}</p> : null}
      {choices.length ? (
        <div className={s.galleryGrid} role="listbox" aria-label={t('aiOptions')}>
          {choices.map(choice => (
            <button key={choice.key} type="button" role="option" aria-selected={value === choice.key} className={s.tile} onClick={() => onPick(choice)} data-template={choice.template}>
              <Preview id={choice.template} code={code} language={language} brand={brand} fontsReady={fontsReady} copy={choice.copy} />
              <span className={s.tileLabel}>{templateName(language, choice.template)} · {words.styles[choice.template.split('-')[1] as keyof typeof words.styles]}</span>
            </button>
          ))}
        </div>
      ) : null}
      {choices.length ? <p className={s.meta}>{t('checkOffers')}</p> : null}
    </div>
  );
}
