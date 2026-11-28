'use client';
import React from 'react';
import { validateSaasSchoolPlanFeatures, type SaasSchoolPlanFeatures } from '@hon/contracts';
import { reportConfirmedSessionInvalidation } from '../session-invalidation';
import type { SchoolShellIcon } from './catalog';
import styles from './shell.module.css';

/**
 * Plan features in the school app (0699; owner decision 2026-11-26: "Locked, with an Upgrade button"). HQ picks each plan's
 * features in the Plan builder; a school on that plan sees the menu pages for features it leaves out with a lock, and the
 * page itself becomes an Upgrade card. Presentation only: the read is display data, never authority, and every page's
 * own API still authorizes on the server. When the read fails, nothing is locked (no school loses a page to a network blip).
 */
export const PLAN_FEATURE_FOR_PAGE: Readonly<Partial<Record<SchoolShellIcon, string>>> = {
  hon: 'assistant.ordinary',
  aiTeam: 'ai.workforce', conversationAi: 'ai.workforce',
  students: 'crm.families_students_prospects', crm: 'crm.families_students_prospects', automation: 'crm.families_students_prospects',
  classes: 'operations.classes_scheduling_attendance', attendance: 'operations.classes_scheduling_attendance',
  billing: 'operations.memberships_payments', checkout: 'operations.memberships_payments', pos: 'operations.memberships_payments', invoices: 'operations.memberships_payments',
  ranks: 'progression.testing_curriculum', testing: 'progression.testing_curriculum', promotions: 'progression.testing_curriculum',
  marketing: 'marketing.campaigns_manual_assisted', website: 'marketing.campaigns_manual_assisted', social: 'marketing.campaigns_manual_assisted',
  ads: 'marketing.connections_reporting',
  creative: 'ai.premium_metered',
  community: 'champions.participation',
  // Dashboard, Staff, Texts, Email, Parent app, Calls, Shopify, Reports and Settings are never locked: Settings holds the
  // subscription page the Upgrade button opens.
};
export const PLAN_UPGRADE_HREF = '/staff/subscription';

/** The menu pages the plan locks, for the frame. */
export function lockedPages(features: SaasSchoolPlanFeatures | null): ReadonlySet<SchoolShellIcon> {
  if (!features || features.locked.length === 0) return new Set();
  const locked = new Set(features.locked);
  return new Set((Object.entries(PLAN_FEATURE_FOR_PAGE) as [SchoolShellIcon, string][]).filter(([, capability]) => locked.has(capability)).map(([page]) => page));
}

const MAX = 16_384;
/** GET /api/v1/schools/:schoolId/plan-features for the verified school. Any refusal or drift rejects; the caller locks nothing. */
export async function readSchoolPlanFeatures(schoolId: string, signal: AbortSignal, owned: () => boolean): Promise<SaasSchoolPlanFeatures> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(schoolId)) throw new Error('INVALID');
  const r = await fetch(`/api/v1/schools/${schoolId}/plan-features`, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal, headers: { Accept: 'application/json' } });
  signal.throwIfAborted();
  if (r.status === 401) { if (owned()) reportConfirmedSessionInvalidation(); throw new Error('SESSION'); }
  if (r.status !== 200 || !/^application\/json\b/i.test(r.headers.get('content-type') ?? '')) throw new Error('UNAVAILABLE');
  const text = await r.text();
  if (text.length > MAX) throw new Error('UNAVAILABLE');
  const body = JSON.parse(text) as { data?: unknown };
  const features = validateSaasSchoolPlanFeatures(body?.data);
  if (features.schoolId.toLowerCase() !== schoolId.toLowerCase()) throw new Error('UNAVAILABLE');
  return features;
}

type LockCopy = Readonly<{ badge: string; title: (page: string) => string; body: (plan: string | null) => string; upgrade: string; locked: string }>;
const COPY: Readonly<Record<'en' | 'ko' | 'es', LockCopy>> = {
  en: { badge: 'Not in your plan', title: page => `${page} is not in your plan`, upgrade: 'Upgrade', locked: 'Locked: not in your plan',
    body: plan => `${plan ? `Your plan, ${plan},` : 'Your plan'} doesn't include this. Upgrade to a plan that does to use it.` },
  ko: { badge: '플랜에 포함되지 않음', title: page => `${page}은(는) 현재 플랜에 포함되어 있지 않습니다`, upgrade: '업그레이드', locked: '잠김: 플랜에 포함되지 않음',
    body: plan => `${plan ? `현재 플랜(${plan})에는` : '현재 플랜에는'} 이 기능이 포함되어 있지 않습니다. 사용하려면 이 기능이 포함된 플랜으로 업그레이드하세요.` },
  es: { badge: 'No incluido en tu plan', title: page => `${page} no está en tu plan`, upgrade: 'Mejorar plan', locked: 'Bloqueado: no está en tu plan',
    body: plan => `${plan ? `Tu plan, ${plan},` : 'Tu plan'} no incluye esto. Cambia a un plan que lo incluya para usarlo.` },
};
export function planLockCopy(language: string): LockCopy { const l = language.slice(0, 2).toLowerCase(); return l === 'ko' || l === 'es' ? COPY[l] : COPY.en; }

/** The small lock shown next to a locked menu page; its words are the link's description, not decoration. */
export function PlanLockMark({ language }: { language: string }): React.ReactElement {
  const c = planLockCopy(language);
  return <span className={styles.planLockMark} data-plan-lock="" title={c.locked}>
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
    <span className={styles.planLockText}>{c.locked}</span></span>;
}

/** Shown in place of a locked page. The page's own requests never start, and the Upgrade button opens the subscription page. */
export function PlanLockedPage({ language, page, planName }: { language: string; page: string; planName: string | null }): React.ReactElement {
  const c = planLockCopy(language);
  return <section className={styles.planLocked} data-plan-locked="" aria-labelledby="hon-plan-locked-title">
    <p className={styles.planLockedBadge}>{c.badge}</p>
    <h1 id="hon-plan-locked-title">{c.title(page)}</h1>
    <p>{c.body(planName)}</p>
    <a className={styles.planUpgrade} href={PLAN_UPGRADE_HREF} data-plan-upgrade="">{c.upgrade}</a>
  </section>;
}
