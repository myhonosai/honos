import { parseOperationalSchoolSelectors, type OperationalSchoolScope } from '../operational-navigation';
import type { ShellKey } from './copy';

/**
 * Closed school-app navigation. Every href is an existing route; nothing here is
 * authority. `scoped` routes accept the existing `organizationId` + `schoolId`
 * prefill, which the destination re-verifies server-side.
 */
export type SchoolShellIcon = 'home' | 'students' | 'crm' | 'classes' | 'billing' | 'aiTeam' | 'analytics' | 'settings';
export type SchoolShellRoute = Readonly<{ href: string; titleKey: ShellKey; scoped: boolean; group?: ShellKey; hidden?: boolean }>;
export type SchoolShellItem = Readonly<{ key: SchoolShellIcon; titleKey: ShellKey; routes: readonly SchoolShellRoute[] }>;

const r = (href: string, titleKey: ShellKey, scoped = false): SchoolShellRoute => ({ href, titleKey, scoped });
/** Design pass (2026-11-15): long areas split their section tabs into a few named groups, so a row never scrolls far. */
/** Owned by an area for "where am I", but reached from a workflow (onboarding), never from tabs or the menu. */
const h = (href: string, titleKey: ShellKey): SchoolShellRoute => ({ href, titleKey, scoped: false, hidden: true });
const g = (group: ShellKey, ...routes: SchoolShellRoute[]): SchoolShellRoute[] => routes.map(route => ({ ...route, group }));

/**
 * Owner decision (2026-11-15): eight main areas. Contacts holds students, families and staff; Enrollment holds leads,
 * marketing and referrals; Reports holds the school's reports and analytics; HON and the AI work queues live with the
 * AI team. Areas with no route yet are absent until a connected page exists; nothing links to an inert screen.
 * Stable keys (`crm`, `students`, `analytics`) are kept so links and browser checks keep working.
 */
export const SCHOOL_SHELL_NAV: readonly SchoolShellItem[] = [
  // Setup (Welcome, School launch, Founder Setup) is onboarding (owner, 2026-11-14): reached from Home's setup card and Settings, not tabs.
  { key: 'home', titleKey: 'navHome', routes: [r('/staff/dashboard', 'routeOverview', true), r('/staff/command-center', 'routeCommandCenter'), r('/staff/work', 'routeWork'),
    h('/staff/welcome', 'routeWelcome'), h('/staff/launch', 'routeLaunch'), h('/staff/founder-setup', 'routeFounderSetup')] },
  { key: 'students', titleKey: 'navStudents', routes: [...g('groupPeople', r('/staff/search', 'routeStudentSearch'), r('/staff/people', 'routePeople'), r('/staff/family-access', 'routeFamilyAccess', true), r('/staff/conversations', 'routeConversations'), r('/staff/family-messages', 'routeFamilyMessages'),
    r('/staff/students/achievements', 'routeAchievements'), r('/staff/retention/review', 'routeRetention'), r('/staff/migration/students', 'routeStudentImport')),
    ...g('groupStaff', r('/staff/team/invitations', 'routeTeam', true), r('/staff/roles', 'routeRoles'), r('/staff/team/availability', 'routeAvailability'), r('/staff/instructor-qualifications', 'routeQualifications'),
    r('/staff/documents', 'routeDocuments'))] },
  { key: 'crm', titleKey: 'navCrm', routes: [...g('groupLeads', r('/staff/crm', 'routeLeadsHome'), r('/staff/crm/leads', 'routeLeads', true), r('/staff/crm/journey', 'routeJourney', true), r('/staff/crm/follow-ups', 'routeFollowUps'),
    r('/staff/crm/trials', 'routeTrials', true), r('/staff/crm/lead-memberships', 'routeLeadMemberships'), r('/staff/migration/leads', 'routeLeadImport')),
    ...g('groupMarketing', r('/staff/marketing', 'routeMarketingHome'), r('/staff/marketing/campaigns', 'routeCampaigns'), r('/staff/marketing/forms', 'routeForms'), r('/staff/marketing/website', 'routeWebsite'),
    r('/staff/marketing/intake', 'routeIntake'), r('/staff/marketing/social', 'routeSocial'), r('/staff/creative-studio', 'routeCreativeStudio'), r('/staff/champions-club', 'routeChampions'))] },
  { key: 'classes', titleKey: 'navClasses', routes: [...g('groupSchedule', r('/staff/schedule', 'routeRosters'), r('/staff/schedule/sessions', 'routeSessions'), r('/staff/schedule/timetable', 'routeTimetable'), r('/staff/schedule/events', 'routeEvents'), r('/staff/schedule/bookings', 'routeBookings'),
    r('/staff/classpass', 'routeClassPass', true), r('/staff/kiosk', 'routeKiosk'), r('/staff/migration/classes', 'routeHistoryImport')),
    ...g('groupAttendance', r('/staff/attendance', 'routeAttendance', true), r('/staff/attendance/planned-absences', 'routePlannedAbsences')),
    ...g('groupCurriculum', r('/staff/curriculum/library', 'routeCurriculumLibrary'), r('/staff/curriculum/progress', 'routeProgress'), r('/staff/teaching-studio', 'routeTeachingStudio'), r('/staff/testing/registrations', 'routeTesting'),
    r('/staff/testing/readiness', 'routeReadiness'), r('/staff/testing/scorecards', 'routeScorecards'), r('/staff/testing/promotion-decisions', 'routePromotions'),
    r('/staff/testing/certificates', 'routeCertificates')), ...g('groupCommunity', r('/community', 'routeCommunity'), r('/community/marketplace', 'routeMarketplace'))] },
  // Owner (2026-11-16): a person's membership is started, paused and cancelled on their contact card; Billing sets up plans.
  // The old activation and pause/cancel pages stay reachable (old links), but leave the tabs and the menu.
  { key: 'billing', titleKey: 'navBilling', routes: [...g('groupMemberships', r('/staff/billing/membership-plans', 'routePlans'), r('/staff/memberships', 'routeMembershipList'),
    h('/staff/billing/memberships', 'routeMemberships'), r('/staff/billing/membership-dates', 'routeDates'), h('/staff/billing/membership-changes', 'routeChanges'),
    r('/staff/billing/renewals', 'routeRenewals'), r('/staff/migration/memberships', 'routeBillingImport')),
    ...g('groupPayments', r('/staff/billing/invoices', 'routeInvoices'), r('/staff/billing/receivables', 'routeReceivables'),
    r('/staff/billing/payment-processors', 'routePaymentProcessors'), r('/staff/billing/checkout-pages', 'routeCheckoutPages'), r('/staff/billing/saved-payment-methods', 'routeSavedMethods'))] },
  // The whole launch roster lives on the AI Team page; HON, approvals and the specialists with their own workspace follow it.
  { key: 'aiTeam', titleKey: 'navAiTeam', routes: [...g('groupTeam', r('/staff/ai-team', 'routeAiTeam'), r('/staff/hon', 'routeHon'), r('/staff/action-center/approvals', 'routeApprovals'), r('/staff/ai-work', 'routeAiWork')),
    ...g('groupSpecialists', r('/staff/leads/assistant', 'routeLeadAssistant'), r('/staff/marketing/assistant', 'routeMarketingAssistant'), r('/staff/teaching-assistant', 'routeKai'), r('/staff/retention/at-risk', 'routeMayaAtRisk'),
    r('/staff/voice', 'routeVoice'))] },
  { key: 'analytics', titleKey: 'navAnalytics', routes: [r('/staff/reports', 'routeSchoolReports'), r('/staff/operations', 'routeOperationsReport', true), r('/staff/health-score', 'routeHealthScore'), r('/staff/planning/revenue', 'routeRevenuePlanning')] },
  { key: 'settings', titleKey: 'navSettings', routes: [r('/staff/settings', 'routeSettingsSummary'), r('/staff/account-status', 'routeAccount'), r('/staff/owners', 'routeOwners'), r('/staff/subscription', 'routeSubscription'),
    r('/staff/settings/branding', 'routeBranding'), r('/staff/settings/booking-types', 'routeBookingTypes'), r('/staff/settings/texting-number', 'routeTextingNumber'), r('/settings/language-region', 'routeLanguage'), r('/settings/texts-from-hon', 'routeTextsFromHon'),
    r('/staff/automation/rules', 'routeAutomation'), r('/staff/help', 'routeHelp')] },
];

/** Reached from a workflow, never from primary navigation. */
export const SCHOOL_SHELL_UNLISTED_ROUTES: readonly string[] = [
  '/staff/entry',
  '/staff/schedule/sessions/create',
  '/staff/testing/candidates/register',
  '/staff/testing/candidates/grade',
  '/staff/search/[organizationId]/[schoolId]/[kind]/[entityId]',
  // The page Facebook or Instagram returns to after a social connection (0347); reached only from Social accounts.
  '/staff/marketing/social/return',
];

/** Mobile bottom bar: four primary destinations plus "More". */
export const SCHOOL_SHELL_MOBILE: readonly SchoolShellIcon[] = ['home', 'students', 'crm', 'classes'];

/** The named groups of an area's section tabs, in catalog order; empty when the area is short enough to show flat. */
export function schoolShellGroups(item: SchoolShellItem): ShellKey[] {
  return [...new Set(item.routes.flatMap(route => route.group && !route.hidden ? [route.group] : []))];
}
/** The routes an area lists in its tabs and in the menu. */
export const schoolShellListed = (item: SchoolShellItem): SchoolShellRoute[] => item.routes.filter(route => !route.hidden);

export function schoolShellHref(route: SchoolShellRoute, selection: OperationalSchoolScope | null): string {
  if (!route.scoped || !selection) return route.href;
  const parsed = parseOperationalSchoolSelectors({ organizationId: selection.organizationId, schoolId: selection.schoolId });
  if (!parsed.initialOrganizationId || !parsed.initialSchoolId) return route.href;
  return `${route.href}?${new URLSearchParams({ organizationId: parsed.initialOrganizationId, schoolId: parsed.initialSchoolId })}`;
}

const owns = (href: string, path: string) => path === href || path.startsWith(`${href}/`);

/** The primary item that owns the path. */
export function schoolShellActiveItem(path: string): SchoolShellItem | null {
  return SCHOOL_SHELL_NAV.find(item => item.routes.some(route => owns(route.href, path))) ?? null;
}

export function schoolShellActiveRoute(path: string): SchoolShellRoute | null {
  const item = schoolShellActiveItem(path);
  return item?.routes.filter(route => owns(route.href, path)).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}
