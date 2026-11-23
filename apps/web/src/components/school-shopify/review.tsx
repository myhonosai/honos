import React, { useEffect, useRef, useState } from 'react';
import { COMMERCE_REVIEW_FOCUSES, type CommerceReviewBrief, type CommerceReviewFocus, type CommerceReviewPoint, type CommerceReviewView } from '@hon/contracts';
import { ReviewError, type ReviewApi, type ReviewErrorKind, type ReviewScope } from './review-http';
import { reviewText, type ReviewKey } from './review-copy';
import styles from './shopify.module.css';

/**
 * CA1 (0615): ask Marcus how the store is doing. The server decides who may ask, what Marcus sees (store totals only) and
 * every AI spend rule. A review is text: nothing here changes HON or Shopify.
 */
type Marcus = { state: 'CHECKING' } | { state: 'OFF' } | { state: 'ON'; asking: boolean };
type Notice = null | { kind: ReviewErrorKind | 'FAILED' | 'BLOCKED' | 'CONFIGURATION_REQUIRED' | 'HELD' | 'REJECTED'; problems?: readonly string[] };
export type CommerceReviewProps = Readonly<{
  language: string; canManage: boolean; locked: boolean; when: (iso: string) => string;
  review: Readonly<{ api: ReviewApi; scope: ReviewScope }>;
}>;
const newKey = (): string => globalThis.crypto.randomUUID();
const shown = (v: CommerceReviewView) => v.status === 'RESULT_RECORDED' || v.status === 'APPLIED';

export function CommerceReview(p: CommerceReviewProps): React.ReactElement {
  const s = (key: ReviewKey, vars?: Record<string, string>) => reviewText(p.language, key, vars);
  const [marcus, setMarcus] = useState<Marcus>({ state: 'CHECKING' });
  const [focus, setFocus] = useState<CommerceReviewFocus>('OVERVIEW');
  const [question, setQuestion] = useState('');
  const [view, setView] = useState<CommerceReviewView | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A request whose answer was lost keeps its key: only the identical request may be sent again, and it is never sent twice.
  const retry = useRef<{ key: string; body: string } | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const { api, scope } = p.review;
  useEffect(() => {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]);
    const owned = () => live.current && !abort.signal.aborted;
    setMarcus({ state: 'CHECKING' }); setView(null); setNotice(null);
    api.list(scope, signal, owned).then(
      (l) => { if (!owned()) return; setMarcus(l.aiAvailable && p.canManage ? { state: 'ON', asking: false } : { state: 'OFF' }); setView(l.requests.find(shown) ?? null); },
      () => { if (owned()) setMarcus({ state: 'OFF' }); });
    return () => { abort.abort(); };
  }, [api, scope.organizationId, scope.schoolId, p.canManage]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = async () => {
    if (marcus.state !== 'ON' || marcus.asking || p.locked) return;
    const body: CommerceReviewBrief = { focus, question: question.trim() }, text = JSON.stringify(body);
    const key = retry.current?.body === text ? retry.current.key : newKey();
    retry.current = { key, body: text };
    setMarcus({ state: 'ON', asking: true }); setNotice(null);
    try {
      const v = await api.request(scope, body, key, AbortSignal.timeout(90000), () => live.current);
      if (!live.current) return;
      retry.current = null; setMarcus({ state: 'ON', asking: false });
      if (v.status === 'RESULT_RECORDED') { setView(v); return; }
      setNotice(v.status === 'RESULT_REJECTED' ? { kind: 'REJECTED', problems: v.problems } : v.status === 'UNKNOWN' ? { kind: 'HELD' }
        : v.status === 'BLOCKED' || v.status === 'CONFIGURATION_REQUIRED' ? { kind: v.status } : { kind: 'FAILED' });
    } catch (error) {
      if (!live.current) return;
      const kind = error instanceof ReviewError ? error.kind : 'UNKNOWN';
      if (kind !== 'UNKNOWN') retry.current = null;
      setMarcus({ state: 'ON', asking: false }); setNotice({ kind });
    }
  };
  const close = (status: 'APPLIED' | 'DISMISSED') => {
    if (!view || !view.mine || view.status !== 'RESULT_RECORDED') return;
    const before = view;
    if (status === 'DISMISSED') setView(null);
    api.close(scope, before.id, status, newKey(), AbortSignal.timeout(30000), () => live.current).then(
      (v) => { if (live.current && status === 'APPLIED') setView(v); },
      (error) => { if (!live.current) return; const kind = error instanceof ReviewError ? error.kind : 'UNKNOWN'; if (kind !== 'GONE') { setNotice({ kind }); if (status === 'DISMISSED') setView(before); } });
  };


  return <section className={styles.card} aria-labelledby="commerce-review-title" data-commerce-review={marcus.state}>
    <div className={styles.cardHead}><h3 id="commerce-review-title">{s('reviewTitle')}</h3></div>
    <p className={styles.meta}>{s('reviewHelp')}</p>
    {marcus.state === 'ON' && <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void ask(); }}>
      <label className={styles.field}>{s('focusLabel')}
        <select value={focus} onChange={e => setFocus(e.target.value as CommerceReviewFocus)} data-review-focus>
          {COMMERCE_REVIEW_FOCUSES.map(f => <option key={f} value={f}>{s(`f_${f}`)}</option>)}</select></label>
      <label className={styles.field}>{s('questionLabel')}<span className={styles.meta}>{s('questionHint')}</span>
        <textarea value={question} maxLength={300} rows={2} onChange={e => setQuestion(e.target.value)} data-review-question /></label>
      <div className={styles.row}><button type="submit" className={styles.primary} disabled={marcus.asking || p.locked} data-ask-review>{marcus.asking ? s('askingReview') : s('askReview')}</button></div>
    </form>}
    {marcus.state === 'OFF' && p.canManage && <p className={styles.meta} data-review-off>{s('reviewOff')}</p>}
    {notice && <div className={`${styles.notice} ${styles.warn}`} role="alert" data-review-notice={notice.kind}>
      <p>{notice.kind === 'REJECTED' ? s('reviewProblems') : s(`ai_${notice.kind}` as ReviewKey)}</p>
      {notice.problems && notice.problems.length > 0 && <ul>{notice.problems.map((x, n) => <li key={n}>{x}</li>)}</ul>}
    </div>}
    {view && shown(view) && <ReviewResult view={view} language={p.language} when={p.when} locked={p.locked} onClose={close} />}
  </section>;
}

/** One recorded review, always under the AI notice. Only the person who asked may mark it reviewed or dismiss it. */
export function ReviewResult({ view, language, when, locked, onClose }: Readonly<{ view: CommerceReviewView; language: string; when: (iso: string) => string; locked: boolean; onClose: (status: 'APPLIED' | 'DISMISSED') => void }>): React.ReactElement {
  const s = (key: ReviewKey, vars?: Record<string, string>) => reviewText(language, key, vars);
  const points = (list: readonly CommerceReviewPoint[]) => <ul className={styles.plainList}>{list.map((x, n) => <li key={n} className={styles.item}>
    <div className={styles.itemHead}><span className={styles.chip}>{s(`a_${x.area}`)}</span> <strong>{x.title}</strong></div><p>{x.detail}</p></li>)}</ul>;
  return <div data-review-result={view.status}>
      <p className={styles.notice}>{s('reviewNotice')}</p>
      <p className={styles.meta}>{s('reviewFor', { focus: s(`f_${view.brief.focus}`), when: when(view.createdAt) })}{!view.mine && ` · ${s('otherReview')}`}</p>
      {view.brief.question && <p className={styles.meta}>{s('reviewQuestion', { question: view.brief.question })}</p>}
      <p className={styles.summary}>{view.summary}</p>
      <h4>{s('findingsTitle')}</h4>{points(view.findings ?? [])}
      <h4>{s('recommendationsTitle')}</h4>
      {(view.recommendations ?? []).length > 0 ? points(view.recommendations ?? []) : <p className={styles.meta}>{s('noRecommendations')}</p>}
      {view.status === 'APPLIED' && view.mine && <p className={styles.meta} data-review-reviewed>{s('reviewed')}</p>}
      {view.status === 'RESULT_RECORDED' && view.mine && <div className={styles.row}>
        <button type="button" className={styles.secondary} disabled={locked} onClick={() => onClose('APPLIED')} data-review-mark>{s('markReviewed')}</button>
        <button type="button" className={styles.linkButton} disabled={locked} onClick={() => onClose('DISMISSED')} data-review-dismiss>{s('dismissReview')}</button>
      </div>}
    </div>;
}
