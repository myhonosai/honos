import { parseOperationalSchoolSelectors, type OperationalSchoolScope } from '../operational-navigation';
import type { ShellKey } from './copy';

/**
 * Closed school-app navigation. Every href is an existing route; nothing here is
 * authority. `scoped` routes accept the existing `organizationId` + `schoolId`
 * prefill, which the destination re-verifies server-side.
 */
export type SchoolShellIcon = 'home' | 'hon' | 'aiTeam' | 'conversationAi' | 'classes' | 'attendance' | 'students' | 'staff' | 'crm' | 'automation' | 'messages' | 'parentApp'
  | 'social' | 'checkout' | 'pos' | 'shopify' | 'invoices' | 'website' | 'marketing' | 'ads' | 'creative' | 'ranks' | 'testing' | 'promotions' | 'billing' | 'analytics' | 'community' | 'settings';
/** Owner menu (David, 2026-11-16 07:52Z): eleven headings, each with its few pages under it. */
export type SchoolShellSection = 'dashboard' | 'ai' | 'calendar' | 'contacts' | 'leads' | 'communication' | 'finance' | 'marketing' | 'ranks' | 'business' | 'community';
export type SchoolShellRoute = Readonly<{ href: string; titleKey: ShellKey; scoped: boolean; hidden?: boolean }>;
/** One menu page. Its routes are the tabs inside the page; `section` is absent only for Settings, which sits at the bottom. */
export type SchoolShellItem = Readonly<{ key: SchoolShellIcon; titleKey: ShellKey; section?: SchoolShellSection; routes: readonly SchoolShellRoute[];
  /** One job done in order (Tests): the shell shows the routes as numbered steps instead of tabs. */
  steps?: true }>;

const r = (href: string, titleKey: ShellKey, scoped = false): SchoolShellRoute => ({ href, titleKey, scoped });
/** Owned by a page for "where am I", but opened from a link on a page (or onboarding), never from tabs or the menu. */
const h = (href: string, titleKey: ShellKey): SchoolShellRoute => ({ href, titleKey, scoped: false, hidden: true });

export const SCHOOL_SHELL_SECTIONS: readonly Readonly<{ key: SchoolShellSection; titleKey: ShellKey }>[] = [
  { key: 'dashboard', titleKey: 'sectionDashboard' }, { key: 'ai', titleKey: 'sectionAi' }, { key: 'calendar', titleKey: 'sectionCalendar' },
  { key: 'contacts', titleKey: 'sectionContacts' }, { key: 'leads', titleKey: 'sectionLeads' }, { key: 'communication', titleKey: 'sectionCommunication' },
  { key: 'finance', titleKey: 'sectionFinance' }, { key: 'marketing', titleKey: 'sectionMarketing' }, { key: 'ranks', titleKey: 'sectionRanks' },
  { key: 'business', titleKey: 'sectionBusiness' }, { key: 'community', titleKey: 'sectionCommunity' },
];

/**
 * Owner menu (2026-11-16, docs/architecture/SCHOOL_APP_TARGET_LAYOUT.md): headings, then pages; a page's tabs are its routes.
 * No third level. Nothing is removed: every existing page is a tab, or hidden with a link to it from its page. Stable keys
 * (`crm`, `students`, `classes`, `billing`, `analytics`) are kept so links and browser checks keep working.
 */
export const SCHOOL_SHELL_NAV: readonly SchoolShellItem[] = [
  // Setup (Welcome, School launch, Founder Setup) is onboarding (owner, 2026-11-14): reached from Home's setup card and Settings.
  { key: 'home', titleKey: 'navHome', section: 'dashboard', routes: [r('/staff/dashboard', 'routeOverview', true), r('/staff/work', 'routeWork'), r('/staff/command-center', 'routeCommandCenter'), r('/staff/tools', 'routeCustomTools'),
    h('/staff/welcome', 'routeWelcome'), h('/staff/launch', 'routeLaunch'), h('/staff/founder-setup', 'routeFounderSetup')] },
  { key: 'hon', titleKey: 'navHon', section: 'dashboard', routes: [r('/staff/hon', 'routeHon')] },
  // Each specialist's workspace opens from that specialist's card on the AI Team page.
  { key: 'aiTeam', titleKey: 'navAiTeam', section: 'ai', routes: [r('/staff/ai-team', 'routeAiTeam'), r('/staff/action-center/approvals', 'routeApprovals'), r('/staff/ai-work', 'routeAiWork'),
    r('/staff/voice', 'routeVoice'), h('/staff/leads/assistant', 'routeLeadAssistant'), h('/staff/marketing/assistant', 'routeMarketingAssistant'),
    h('/staff/teaching-assistant', 'routeKai'), h('/staff/retention/at-risk', 'routeMayaAtRisk'),
    h('/staff/ai-team/alex', 'routeAlex'), h('/staff/ai-team/jordan', 'routeJordan'), h('/staff/ai-team/claire', 'routeClaire'), h('/staff/ai-team/lena', 'routeLena')] },
  // Conversation AI answers the school's texts in Texts > Conversations (0364); its training and settings stay here.
  { key: 'conversationAi', titleKey: 'navConversationAi', section: 'ai', routes: [r('/staff/conversations/train-ai', 'routeTrainAi')] },
  // Owner ask (2026-11-16): rosters, class schedule, weekly timetable, sale days and events and class booking are one
  // Calendar page; /staff/schedule owns every /staff/schedule/* path, so the old pages and workflow pages still mark Classes.
  { key: 'classes', titleKey: 'navClasses', section: 'calendar', routes: [r('/staff/schedule', 'routeCalendar')] },
  { key: 'attendance', titleKey: 'navAttendance', section: 'calendar', routes: [r('/staff/attendance', 'routeAttendance', true), r('/staff/attendance/planned-absences', 'routePlannedAbsences'), r('/staff/attendance/scan', 'routeScanCheckIn'), r('/staff/attendance/cards', 'routeAttendanceCards'), r('/staff/attendance/face', 'routeFaceCheckIn'),
    r('/staff/walk-in', 'routeWalkIn'), r('/staff/migration/classes', 'routeHistoryImport'), h('/staff/kiosk', 'routeKiosk'), h('/staff/classpass', 'routeClassPass')] },
  // Search is the search button in the top bar.
  { key: 'students', titleKey: 'navStudents', section: 'contacts', routes: [r('/staff/people', 'routePeople'), r('/staff/family-access', 'routeFamilyAccess', true),
    r('/staff/migration/students', 'routeStudentImport'), r('/staff/migration/photos', 'routePaperImport'), h('/staff/search', 'routeStudentSearch')] },
  { key: 'staff', titleKey: 'navStaff', section: 'contacts', routes: [r('/staff/team/invitations', 'routeTeam', true), r('/staff/roles', 'routeRoles'), r('/staff/team/shifts', 'routeShifts'), r('/staff/team/hours', 'routeHours'), r('/staff/team/availability', 'routeAvailability'),
    r('/staff/instructor-qualifications', 'routeQualifications'), r('/staff/documents', 'routeDocuments')] },
  { key: 'crm', titleKey: 'navCrm', section: 'leads', routes: [r('/staff/crm', 'routeLeadsHome'), h('/staff/crm/leads', 'routeLeads'), h('/staff/crm/journey', 'routeJourney'),
    r('/staff/crm/follow-ups', 'routeFollowUps'), r('/staff/crm/trials', 'routeTrials', true), r('/staff/crm/lead-memberships', 'routeLeadMemberships'), r('/staff/migration/leads', 'routeLeadImport')] },
  { key: 'automation', titleKey: 'navAutomation', section: 'leads', routes: [r('/staff/automations', 'routeAutomation'), h('/staff/automation/rules', 'routeAutomationRules')] },
  // Owner ask (2026-11-19, docs/architecture/SCHOOL_TEXTS_AND_EMAIL_PAGES.md): texts and email are separate pages with their own
  // tabs, modeled on the owner's current CRM; the parent app chat is its own page laid out like the texts inbox.
  { key: 'messages', titleKey: 'navMessages', section: 'communication', routes: [r('/staff/texts', 'routeConversations'), r('/staff/texts/send', 'routeTextsSend'),
    r('/staff/texts/history', 'routeTextsHistory'), r('/staff/texts/templates', 'routeTextsTemplates'), r('/staff/texts/opted-out', 'routeTextsOptedOut')] },
  { key: 'parentApp', titleKey: 'navParentApp', section: 'communication', routes: [r('/staff/family-messages', 'routeFamilyMessages'), r('/staff/family-messages/announcements', 'routeAnnouncements'), r('/staff/parent-app/curriculum', 'routeParentAppCurriculum')] },
  { key: 'social', titleKey: 'navSocial', section: 'communication', routes: [r('/staff/marketing/social', 'routeSocial')] },
  { key: 'checkout', titleKey: 'navCheckout', section: 'finance', routes: [r('/staff/billing/checkout-pages', 'routeCheckoutPages'), r('/staff/billing/checkout-orders', 'routeCheckoutOrders')] },
  { key: 'pos', titleKey: 'navPos', section: 'finance', routes: [r('/staff/billing/pos', 'routePointOfSale')] },
  // Shopify (0405): the school's own store, read-only mirror plus connect, sync and disconnect.
  { key: 'shopify', titleKey: 'navShopify', section: 'finance', routes: [r('/staff/billing/shopify', 'routeShopify')] },
  { key: 'invoices', titleKey: 'navInvoices', section: 'finance', routes: [r('/staff/billing/invoices', 'routeInvoices'), r('/staff/billing/receivables', 'routeReceivables')] },
  { key: 'website', titleKey: 'navWebsite', section: 'marketing', routes: [r('/staff/marketing/website', 'routeWebsite'), r('/staff/marketing/forms', 'routeForms'), r('/staff/marketing/intake', 'routeIntake')] },
  { key: 'marketing', titleKey: 'navMarketing', section: 'marketing', routes: [r('/staff/marketing', 'routeMarketingHome'), r('/staff/marketing/campaigns', 'routeCampaigns'), r('/staff/marketing/referrals', 'routeReferrals'), r('/staff/marketing/blasts', 'routeBlasts'), r('/staff/champions-club', 'routeChampions')] },
  // Owner ask (2026-11-17): Meta Ads and Google Ads are connected and set up from Marketing, with Marcus drafting each ad.
  { key: 'ads', titleKey: 'navAds', section: 'marketing', routes: [r('/staff/marketing/ads', 'routeAds')] },
  { key: 'creative', titleKey: 'navCreative', section: 'marketing', routes: [r('/staff/creative-studio', 'routeCreativeStudio')] },
  { key: 'ranks', titleKey: 'navRanks', section: 'ranks', routes: [r('/staff/curriculum/library', 'routeCurriculumLibrary'), r('/staff/curriculum/progress', 'routeProgress'),
    r('/staff/teaching-studio', 'routeTeachingStudio'), r('/staff/students/achievements', 'routeAchievements')] },
  // A belt test is one job in order (L3): who is ready, sign-ups, register, grade, scorecards, certificates.
  { key: 'testing', titleKey: 'navTesting', section: 'ranks', steps: true, routes: [r('/staff/testing/readiness', 'routeTestReady'), r('/staff/testing/registrations', 'routeTestSignups'),
    r('/staff/testing/candidates/register', 'routeTestRegister'), r('/staff/testing/candidates/grade', 'routeTestGrade'),
    r('/staff/testing/scorecards', 'routeScorecards'), r('/staff/testing/certificates', 'routeCertificates')] },
  { key: 'promotions', titleKey: 'navPromotions', section: 'ranks', routes: [r('/staff/testing/promotion-decisions', 'routePromotions')] },
  { key: 'billing', titleKey: 'navBilling', section: 'business', routes: [r('/staff/billing/membership-plans', 'routePlans'), r('/staff/memberships', 'routeMembershipList'),
    r('/staff/billing/memberships', 'routeMemberships'), r('/staff/billing/membership-dates', 'routeDates'), r('/staff/billing/membership-changes', 'routeChanges'),
    r('/staff/billing/renewals', 'routeRenewals'), r('/staff/migration/memberships', 'routeBillingImport')] },
  { key: 'analytics', titleKey: 'navAnalytics', section: 'business', routes: [r('/staff/reports', 'routeSchoolReports'), r('/staff/operations', 'routeOperationsReport', true), r('/staff/health-score', 'routeHealthScore'),
    r('/staff/planning/revenue', 'routeRevenuePlanning'), r('/staff/retention/review', 'routeRetention')] },
  { key: 'community', titleKey: 'navCommunity', section: 'community', routes: [r('/community', 'routeCommunity'), r('/community/marketplace', 'routeMarketplace')] },
  { key: 'settings', titleKey: 'navSettings', routes: [r('/staff/settings', 'routeSettingsSummary'), r('/staff/settings/location', 'routeLocation'), r('/staff/settings/face-check-in', 'routeFaceCheckIn'), r('/staff/settings/branding', 'routeBranding'),
    r('/staff/settings/booking-types', 'routeBookingTypes'), r('/staff/settings/texting-number', 'routeTextingNumber'), r('/staff/settings/demo-data', 'routeDemoData'), r('/staff/billing/payment-processors', 'routePaymentProcessors'),
    r('/staff/billing/saved-payment-methods', 'routeSavedMethods'), r('/settings/language-region', 'routeLanguage'), r('/settings/texts-from-hon', 'routeTextsFromHon'),
    r('/staff/account-status', 'routeAccount'), r('/staff/owners', 'routeOwners'), r('/staff/subscription', 'routeSubscription'), r('/staff/tool-maker', 'routeToolMaker'), r('/staff/help', 'routeHelp')] },
];

/** Reached from a workflow, never from primary navigation. */
export const SCHOOL_SHELL_UNLISTED_ROUTES: readonly string[] = [
  '/staff/entry',
  '/staff/schedule/sessions/create',
  // Part of Classes > Calendar (2026-11-16): the booking page is opened from other pages with a class chosen; the other
  // three redirect to the matching Calendar tab for old links and bookmarks.
  '/staff/schedule/bookings',
  '/staff/schedule/sessions',
  '/staff/schedule/timetable',
  '/staff/schedule/events',
  // The old SMS inbox address (0364) redirects to Texts > Conversations (2026-11-19) for old links and bookmarks.
  '/staff/conversations',
  '/staff/search/[organizationId]/[schoolId]/[kind]/[entityId]',
  // One custom tool's own section (0415); reached from Custom tools, never from the static menu.
  '/staff/tools/[toolKey]',
  // The page Facebook or Instagram returns to after a social connection (0347); reached only from Social accounts.
  '/staff/marketing/social/return',
  // The page Shopify returns to after the owner approves a store connection (0405); reached only from Shopify.
  '/staff/billing/shopify/return',
];

/** Mobile bottom bar: four primary destinations plus "More". */
export const SCHOOL_SHELL_MOBILE: readonly SchoolShellIcon[] = ['home', 'students', 'crm', 'classes'];
/** Modern top bar: the everyday pages; every other page is one click away in the Menu (owner layout, 2026-11-16). */
export const SCHOOL_SHELL_EVERYDAY: readonly SchoolShellIcon[] = ['home', 'classes', 'attendance', 'students', 'crm', 'messages'];

/** The menu pages under one heading, in catalog order. */
export const schoolShellSectionItems = (section: SchoolShellSection): SchoolShellItem[] => SCHOOL_SHELL_NAV.filter(item => item.section === section);
/** Pages that sit at the bottom of the menu, not under a heading (Settings). */
export const schoolShellFooterItems = (): SchoolShellItem[] => SCHOOL_SHELL_NAV.filter(item => !item.section);

/** The routes an area lists in its tabs and in the menu. */
export const schoolShellListed = (item: SchoolShellItem): SchoolShellRoute[] => item.routes.filter(route => !route.hidden);

export function schoolShellHref(route: SchoolShellRoute, selection: OperationalSchoolScope | null): string {
  if (!route.scoped || !selection) return route.href;
  const parsed = parseOperationalSchoolSelectors({ organizationId: selection.organizationId, schoolId: selection.schoolId });
  if (!parsed.initialOrganizationId || !parsed.initialSchoolId) return route.href;
  return `${route.href}?${new URLSearchParams({ organizationId: parsed.initialOrganizationId, schoolId: parsed.initialSchoolId })}`;
}

const owns = (href: string, path: string) => path === href || path.startsWith(`${href}/`);

/** The primary item that owns the path: the one with the longest matching route, so /staff/marketing/ads is Ads, not Marketing. */
export function schoolShellActiveItem(path: string): SchoolShellItem | null {
  let best: SchoolShellItem | null = null, length = -1;
  for (const item of SCHOOL_SHELL_NAV) for (const route of item.routes) if (owns(route.href, path) && route.href.length > length) { best = item; length = route.href.length; }
  return best;
}

export function schoolShellActiveRoute(path: string): SchoolShellRoute | null {
  const item = schoolShellActiveItem(path);
  return item?.routes.filter(route => owns(route.href, path)).sort((a, b) => b.href.length - a.href.length)[0] ?? null;
}
