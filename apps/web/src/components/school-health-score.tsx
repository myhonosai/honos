'use client';

import React, { useEffect, useRef, useState, type FormEvent } from 'react';
import type { HealthScoreCategoryReason, SchoolHealthScoreSnapshot } from '@hon/contracts';
import { DEFAULT_HON_INTERFACE_THEME, type HonInterfaceTheme } from '@hon/design-system';
import { HealthScoreAccessError, loadSchoolHealthScore } from './health-score-http';
import { InterfaceThemePicker } from './interface-theme-picker';
import { loadInterfaceThemePreference, saveInterfaceThemePreference } from './interface-theme-preference';
import styles from './staff-dashboard.module.css';

const HIDDEN_KEY = 'hon.school-health-score.hidden-panels.v1';
const SECTION = { FORMULA: 'formula', CATEGORIES: 'categories', LIMITS: 'limits' } as const;
const reasonText: Record<HealthScoreCategoryReason, string> = {
  MIN_COMPLETED_SESSIONS: 'Fewer than 4 completed class sessions were recorded in this trailing 28-day UTC window.',
  MIN_RECORDED_ATTENDANCE_OBSERVATIONS: 'Fewer than 20 recorded attendance observations were linked to those completed sessions.',
  MIN_RECENT_LEADS: 'Fewer than 5 CRM leads were created in this trailing 56-day UTC window.',
  MIN_RECENT_TRIAL_APPOINTMENTS: 'Fewer than 3 trial appointments started in this trailing 56-day UTC window.',
  MIN_MEMBERSHIP_TERMS_ENDED: 'Fewer than 5 membership records with meaningful terms ended in this trailing 90-day UTC window.',
  MIN_RENEWAL_REVIEWS_RECORDED: 'Fewer than 3 human renewal reviews were recorded in this trailing 90-day UTC window.',
  NO_RECENT_OPERATIONS_WORKLOAD_SAMPLE: 'No pending approval or nonterminal work item was created in this trailing 28-day UTC window.',
};
const definitions = {
  attendanceEngagement: { title: 'Attendance engagement', source: 'Completed class sessions and recorded attendance observations only.', evidence: ['Completed sessions', 'Recorded observations', 'Engaged observations'] },
  pipelineTrial: { title: 'Pipeline / trial recording', source: 'CRM lead creation and trial appointment outcome recording only; it is not a conversion or enrollment measure.', evidence: ['Leads created', 'Trial appointments', 'Outcomes recorded'] },
  retention: { title: 'Term / renewal observability', source: 'Membership terms that ended and human renewal review records only; it does not predict retention or cancellation.', evidence: ['Terms ended', 'Renewal reviews'] },
  operations: { title: 'Operations workload', source: 'Pending Action Engine approvals and nonterminal durable work created in the displayed window only.', evidence: ['Pending approvals', 'Outstanding work'] },
} as const;

type InterfaceThemeState = 'UNAVAILABLE' | 'LOADING' | 'READY' | 'SAVING' | 'ERROR';

function PlatformViewSelector({ interfaceTheme, interfaceThemeState, interfaceThemeMessage, onChange }: {
  interfaceTheme: HonInterfaceTheme;
  interfaceThemeState: InterfaceThemeState;
  interfaceThemeMessage: string;
  onChange: (theme: HonInterfaceTheme) => void;
}): React.ReactElement {
  return <section className={styles.platformView} aria-labelledby="platform-view-heading">
    <div><p className={styles.eyebrow}>PRESENTATION ONLY / VERIFIED SCHOOL</p><h2 id="platform-view-heading">Platform View</h2><p>Big-Button / Phone, Modern HON, and Classic CRM change touch targets and density only. They use the same verified Health Score snapshot, formula, evidence gates, current-school scope, permission checks, and local-only hide behavior.</p></div>
    <InterfaceThemePicker current={interfaceTheme} onChange={onChange} disabled={interfaceThemeState !== 'READY'} busy={interfaceThemeState === 'LOADING' || interfaceThemeState === 'SAVING'} presentation={interfaceTheme === 'classic' ? 'compact' : 'cards'} ariaLabel="Platform View for the verified current school" />
    <p className={styles.platformViewStatus} role="status" aria-live="polite">{interfaceThemeMessage}</p>
  </section>;
}
function utc(value: string) { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(value)); }
function localHidden(): string[] { try { const value = JSON.parse(window.localStorage.getItem(HIDDEN_KEY) ?? '[]'); return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : []; } catch { return []; } }
function panelButton(id: string, hide: (value: string) => void) { return <button type="button" onClick={() => hide(id)}>Hide this panel locally</button>; }
function evidenceValues(category: SchoolHealthScoreSnapshot['categories'][keyof SchoolHealthScoreSnapshot['categories']]) { return Object.values(category.evidence) as number[]; }
function CategoryCard({ snapshot, name }: { snapshot: SchoolHealthScoreSnapshot; name: keyof typeof definitions }) {
  const category = snapshot.categories[name]; const definition = definitions[name]; const values = evidenceValues(category);
  return <article className={category.status === 'AVAILABLE' ? styles.card : styles.unavailable}><header><p>{category.status === 'AVAILABLE' ? 'DETERMINISTIC CATEGORY' : 'INSUFFICIENT DATA'}</p><h2>{definition.title}</h2></header><p className={styles.cardIntro}>{definition.source}</p><dl className={styles.metrics}>{category.status === 'AVAILABLE' && <div className={styles.metric}><dt>Category indicator</dt><dd>{category.score}</dd><small>0–100; fixed formula, not a forecast</small></div>}{definition.evidence.map((label, index) => <div className={styles.metric} key={label}><dt>{label}</dt><dd>{values[index]!.toLocaleString('en-US')}</dd></div>)}</dl><small>UTC window: {utc(category.windowFrom)} – {utc(category.windowTo)}</small>{category.status === 'INSUFFICIENT_DATA' && <ul>{category.reasons.map(reason => <li key={reason}>{reasonText[reason]}</li>)}</ul>}</article>;
}
export function SchoolHealthScore(): React.ReactElement {
  const [organizationId, setOrganizationId] = useState(''); const [schoolId, setSchoolId] = useState(''); const [snapshot, setSnapshot] = useState<SchoolHealthScoreSnapshot | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [hidden, setHidden] = useState<string[]>([]);
  const [interfaceTheme, setInterfaceTheme] = useState<HonInterfaceTheme>(DEFAULT_HON_INTERFACE_THEME);
  const [interfaceThemeState, setInterfaceThemeState] = useState<InterfaceThemeState>('UNAVAILABLE');
  const [interfaceThemeMessage, setInterfaceThemeMessage] = useState('Load a verified school Health Score to view or change your personal Platform View preference.');
  const generation = useRef(0); const interfaceThemeGeneration = useRef(0);
  useEffect(() => { setHidden(localHidden()); }, []);
  useEffect(() => () => { generation.current += 1; interfaceThemeGeneration.current += 1; }, []);
  useEffect(() => {
    if (!snapshot) {
      interfaceThemeGeneration.current += 1; setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE');
      setInterfaceThemeMessage('Load a verified school Health Score to view or change your personal Platform View preference.'); return;
    }
    const current = ++interfaceThemeGeneration.current; const scope = { organizationId: snapshot.organizationId, schoolId: snapshot.schoolId };
    setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('LOADING'); setInterfaceThemeMessage('Loading your personal Platform View preference for this verified current school…');
    void loadInterfaceThemePreference(scope).then(preference => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY');
      setInterfaceThemeMessage(preference.selectedVia === 'DEFAULT' ? 'Modern HON is the visual default for this verified current school. Choosing another presentation is optional.' : 'Saved for your current user and this verified current school only. It never changes formula, evidence, permissions, authority, or Health Score behavior.');
    }).catch(reason => {
      if (current !== interfaceThemeGeneration.current) return;
      setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('ERROR');
      setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} Modern HON remains a visual default only; no preference was loaded or saved.`);
    });
    return () => { if (current === interfaceThemeGeneration.current) interfaceThemeGeneration.current += 1; };
  }, [snapshot?.organizationId, snapshot?.schoolId]);
  function clear() { generation.current += 1; interfaceThemeGeneration.current += 1; setSnapshot(null); setError(''); setInterfaceTheme(DEFAULT_HON_INTERFACE_THEME); setInterfaceThemeState('UNAVAILABLE'); setInterfaceThemeMessage('Load a verified school Health Score to view or change your personal Platform View preference.'); }
  function persist(next: string[]) { const unique = [...new Set(next)]; setHidden(unique); try { window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(unique)); } catch { /* Browser-local preference is optional. */ } }
  async function chooseInterfaceTheme(next: HonInterfaceTheme) {
    if (!snapshot || interfaceThemeState !== 'READY') return;
    const current = ++interfaceThemeGeneration.current; const scope = { organizationId: snapshot.organizationId, schoolId: snapshot.schoolId };
    setInterfaceThemeState('SAVING'); setInterfaceThemeMessage('Saving your personal Platform View preference for this verified current school…');
    try { const preference = await saveInterfaceThemePreference(scope, next, crypto.randomUUID(), 'SETTINGS'); if (current !== interfaceThemeGeneration.current) return; setInterfaceTheme(preference.interfaceTheme); setInterfaceThemeState('READY'); setInterfaceThemeMessage('Saved for your current user and this verified current school only. It never changes formula, evidence, permissions, authority, or Health Score behavior.'); }
    catch (reason) { if (current !== interfaceThemeGeneration.current) return; setInterfaceThemeState('ERROR'); setInterfaceThemeMessage(`${reason instanceof Error ? reason.message : 'The personal Platform View preference is unavailable.'} No presentation preference was saved.`); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (loading) return; clear(); const current = generation.current; setLoading(true);
    try { const next = await loadSchoolHealthScore(organizationId, schoolId); if (current !== generation.current) return; setSnapshot(next); }
    catch (reason) { if (current !== generation.current) return; if (reason instanceof HealthScoreAccessError) setSnapshot(null); setError(reason instanceof Error ? reason.message : 'The Health Score is unavailable.'); }
    finally { if (current === generation.current) setLoading(false); }
  }
  const themeClass = interfaceTheme === 'big-button' ? styles.bigButton : interfaceTheme === 'classic' ? styles.classic : styles.modern;
  return <main className={`${styles.page} ${themeClass}`} data-interface-theme={interfaceTheme}><nav aria-label="Staff navigation"><a href="/staff/dashboard">Operations dashboard</a><a href="/staff/command-center">School Command Center</a><a href="/staff/search">Staff search</a><a href="/staff/billing/renewals">Renewal reviews</a><a href="/auth/login">Sign in</a></nav><header className={styles.header}><p className={styles.eyebrow}>STAFF / SCHOOL HEALTH SCORE</p><h1>School Health Score</h1><p>Optional, conventional, read-only operational indicator. It extends the School Command Center; it does not replace it or any normal school workflow.</p></header><aside className={styles.notice}><strong>Operational indicator only.</strong><p>It is not a forecast, a cancellation or churn certainty, cash revenue, or a recommendation for consequential changes. No AI, provider, Action Engine execution, or mutation is used.</p></aside><section className={styles.scopeSection} aria-labelledby="health-score-scope"><div><h2 id="health-score-scope">Verified current school</h2><p>Enter already-known staff-context IDs. Known IDs select one school; they never grant access.</p></div><form onSubmit={submit} aria-busy={loading}><fieldset disabled={loading}><label>Organization UUID<input required autoComplete="off" spellCheck={false} value={organizationId} onChange={event => { setOrganizationId(event.target.value); clear(); }} /></label><label>School UUID<input required autoComplete="off" spellCheck={false} value={schoolId} onChange={event => { setSchoolId(event.target.value); clear(); }} /></label><button type="submit">{loading ? 'Verifying school…' : 'Load Health Score'}</button></fieldset></form>{!snapshot && !loading && !error && <p className={styles.scopeState} role="status">No verified school is selected. No Health Score data is shown.</p>}{loading && <p className={styles.scopeState} role="status">Verifying access and loading deterministic aggregate evidence…</p>}{error && <p className={styles.error} role="alert">{error}</p>}{snapshot && <div className={styles.verified} role="status"><strong>Verified current school</strong><span>Organization <code>{snapshot.organizationId}</code></span><span>School <code>{snapshot.schoolId}</code></span><span>Tier: {snapshot.entitlementTier}</span><span>Generated: {utc(snapshot.generatedAt)} UTC</span></div>}</section>{snapshot && <PlatformViewSelector interfaceTheme={interfaceTheme} interfaceThemeState={interfaceThemeState} interfaceThemeMessage={interfaceThemeMessage} onChange={theme => void chooseInterfaceTheme(theme)} />}{snapshot && <><section className={styles.queueSection} aria-labelledby="health-score-result">{snapshot.overall.status === 'AVAILABLE' ? <><p className={styles.eyebrow}>SUFFICIENT DATA</p><h2 id="health-score-result">Overall operational indicator: {snapshot.overall.score}/100</h2><p>All fixed data-sufficiency criteria are met. This is a transparent weighted aggregate, not a prediction or risk claim.</p></> : <><p className={styles.eyebrow}>INSUFFICIENT DATA</p><h2 id="health-score-result">No overall score is shown</h2><p>HON does not fabricate a zero, healthy, or risk claim when any defined category lacks its required source sample.</p><ul>{snapshot.overall.reasons.map(item => <li key={item.category}><strong>{item.category.replaceAll('_', ' ')}:</strong> {item.reasons.map(reason => reasonText[reason]).join(' ')}</li>)}</ul></>}</section>{!hidden.includes(SECTION.FORMULA) && <section className={styles.queueSection}><p className={styles.eyebrow}>FIXED FORMULA</p><h2>Formula {snapshot.formulaVersion}</h2><p>When and only when all categories are sufficient: attendance engagement × {snapshot.weights.attendanceEngagement}% + pipeline/trial recording × {snapshot.weights.pipelineTrial}% + term/renewal observability × {snapshot.weights.retention}% + operations workload × {snapshot.weights.operations}%. Every subscore is clamped to 0–100.</p><p>{snapshot.indicatorStatement}</p>{panelButton(SECTION.FORMULA, id => persist([...hidden, id]))}</section>}{!hidden.includes(SECTION.CATEGORIES) && <section aria-label="Health Score category evidence"><div className={styles.queueSection}><p className={styles.eyebrow}>EVIDENCE AND SOURCES</p><h2>Defined aggregate inputs</h2><p>Each category has an explicit UTC half-open window and source sample gate. Names, contacts, notes, invoices, payment data, action payloads, work details, private evidence, provider/model data, and directory IDs are not returned.</p>{panelButton(SECTION.CATEGORIES, id => persist([...hidden, id]))}</div><div className={styles.cards}><CategoryCard snapshot={snapshot} name="attendanceEngagement" /><CategoryCard snapshot={snapshot} name="pipelineTrial" /><CategoryCard snapshot={snapshot} name="retention" /><CategoryCard snapshot={snapshot} name="operations" /></div></section>}{!hidden.includes(SECTION.LIMITS) && <section className={styles.notice}><strong>Transparent limits</strong><p>Trial outcome recording is not trial conversion or enrollment. Term/renewal observability is not churn/cancellation certainty. Current operational workload is not a recommendation to execute an action. Hide/restore is browser-local and does not change data, authority, tier, or scoring.</p>{panelButton(SECTION.LIMITS, id => persist([...hidden, id]))}</section>}{hidden.length > 0 && <section className={styles.notice}><strong>{hidden.length} local {hidden.length === 1 ? 'preference is' : 'preferences are'} applied.</strong><p>Only this browser hides safe display panels; it cannot change any Health Score fact or authorization.</p><button type="button" onClick={() => persist([])}>Restore all hidden panels</button></section>}</>}</main>;
}
