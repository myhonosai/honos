import { parseOperationalSchoolSelectors, type OperationalSchoolScope } from '../operational-navigation';
import type { ShellKey } from './copy';

/**
 * Closed school-app navigation. Every href is an existing route; nothing here is
 * authority. `scoped` routes accept the existing `organizationId` + `schoolId`
 * prefill, which the destination re-verifies server-side.
 */
export type SchoolShellIcon = 'home' | 'hon' | 'aiTeam' | 'crm' | 'students' | 'billing' | 'classes' | 'attendance' | 'marketing'
  | 'community' | 'analytics' | 'staff' | 'settings';
export type SchoolShellRoute = Readonly<{ href: string; titleKey: ShellKey; scoped: boolean }>;
export type SchoolShellItem = Readonly<{ key: SchoolShellIcon; titleKey: ShellKey; routes: readonly SchoolShellRoute[] }>;

const r = (href: string, titleKey: ShellKey, scoped = false): SchoolShellRoute => ({ href, titleKey, scoped });

/**
 * Owner blueprint (2026-11-06) section 9 information architecture. Areas with no
 * route yet (Referrals & Rewards, Connections) are deliberately absent until a
 * connected page exists; nothing links to an inert screen.
 */
export const SCHOOL_SHELL_NAV: readonly SchoolShellItem[] = [
  { key: 'home', titleKey: 'navHome', routes: [r('/staff/dashboard', 'routeOverview', true), r('/staff/operations', 'routeOperationsReport', true), r('/staff/command-center', 'routeCommandCenter')] },
  { key: 'hon', titleKey: 'navHon', routes: [r('/staff/hon', 'routeHon'), r('/staff/action-center/approvals', 'routeApprovals'), r('/staff/ai-work', 'routeAiWork')] },
  { key: 'aiTeam', titleKey: 'navAiTeam', routes: [r('/staff/leads/assistant', 'routeLeadAssistant'), r('/staff/marketing/assistant', 'routeMarketingAssistant'),
    r('/staff/teaching-assistant', 'routeKai'), r('/staff/teaching-studio', 'routeTeachingStudio')] },
  { key: 'crm', titleKey: 'navCrm', routes: [r('/staff/crm/leads', 'routeLeads', true), r('/staff/crm/journey', 'routeJourney', true), r('/staff/crm/follow-ups', 'routeFollowUps'),
    r('/staff/crm/trials', 'routeTrials', true), r('/staff/crm/lead-memberships', 'routeLeadMemberships'), r('/staff/migration/leads', 'routeLeadImport')] },
  { key: 'students', titleKey: 'navStudents', routes: [r('/staff/search', 'routeStudentSearch'), r('/staff/people', 'routePeople'), r('/staff/family-access', 'routeFamilyAccess', true),
    r('/staff/students/achievements', 'routeAchievements'), r('/staff/retention/review', 'routeRetention')] },
  { key: 'billing', titleKey: 'navBilling', routes: [r('/staff/billing/memberships', 'routeMemberships'), r('/staff/billing/membership-plans', 'routePlans'),
    r('/staff/billing/membership-dates', 'routeDates'), r('/staff/billing/renewals', 'routeRenewals'), r('/staff/billing/invoices', 'routeInvoices')] },
  { key: 'classes', titleKey: 'navClasses', routes: [r('/staff/schedule/sessions', 'routeSessions'), r('/staff/schedule/bookings', 'routeBookings'),
    r('/staff/classpass', 'routeClassPass', true), r('/staff/kiosk', 'routeKiosk')] },
  { key: 'attendance', titleKey: 'navAttendance', routes: [r('/staff/attendance', 'routeAttendance', true), r('/staff/attendance/planned-absences', 'routePlannedAbsences'),
    r('/staff/curriculum/library', 'routeCurriculumLibrary'), r('/staff/curriculum/progress', 'routeProgress'), r('/staff/testing/registrations', 'routeTesting'),
    r('/staff/testing/readiness', 'routeReadiness'), r('/staff/testing/scorecards', 'routeScorecards'), r('/staff/testing/promotion-decisions', 'routePromotions'),
    r('/staff/testing/certificates', 'routeCertificates')] },
  { key: 'marketing', titleKey: 'navMarketing', routes: [r('/staff/marketing/campaigns', 'routeCampaigns'), r('/staff/marketing/forms', 'routeForms'),
    r('/staff/marketing/intake', 'routeIntake'), r('/staff/creative-studio', 'routeCreativeStudio')] },
  { key: 'community', titleKey: 'navCommunity', routes: [r('/community', 'routeCommunity'), r('/community/marketplace', 'routeMarketplace')] },
  { key: 'analytics', titleKey: 'navAnalytics', routes: [r('/staff/health-score', 'routeHealthScore'), r('/staff/planning/revenue', 'routeRevenuePlanning')] },
  { key: 'staff', titleKey: 'navStaff', routes: [r('/staff/work', 'routeWork'), r('/staff/automation/rules', 'routeAutomation'), r('/staff/team/invitations', 'routeTeam', true),
    r('/staff/roles', 'routeRoles'), r('/staff/team/availability', 'routeAvailability'), r('/staff/instructor-qualifications', 'routeQualifications'),
    r('/staff/documents', 'routeDocuments'), r('/staff/voice', 'routeVoice')] },
  { key: 'settings', titleKey: 'navSettings', routes: [r('/staff/account-status', 'routeAccount'), r('/staff/subscription', 'routeSubscription'),
    r('/staff/launch', 'routeLaunch'), r('/settings/language-region', 'routeLanguage')] },
];

/** Reached from a workflow, never from primary navigation. */
export const SCHOOL_SHELL_UNLISTED_ROUTES: readonly string[] = [
  '/staff/entry',
  '/staff/schedule/sessions/create',
  '/staff/testing/candidates/register',
  '/staff/testing/candidates/grade',
  '/staff/search/[organizationId]/[schoolId]/[kind]/[entityId]',
];

/** Mobile bottom bar: four primary destinations plus "More". */
export const SCHOOL_SHELL_MOBILE: readonly SchoolShellIcon[] = ['home', 'hon', 'crm', 'classes'];

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
