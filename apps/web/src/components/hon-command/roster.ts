import type { AiDraftWorkAgentKey } from '@hon/contracts';
import { HON_AI_TEAM, type HonAiTeamId, type HonInterfaceTheme } from '@hon/design-system';

/**
 * Frontend capability registry for the unified HON command experience.
 *
 * Identity (name, approved role title, original portrait) is read from the
 * protected design-system roster and never redefined here. Everything else is a
 * truthful description of which EXISTING frontend/backend contract an agent can
 * reach today. Nothing here is an authority, permission, tool grant, model route
 * or entitlement: the APIs behind each linked workflow re-check all of those.
 */

export type HonCapabilityState = 'AVAILABLE' | 'BACKEND_REQUIRED';
/** ANSWERS (K2, 0260): a read-only analysis specialist answering questions in Ask HON; it never drafts or acts. */
export type HonAgentAvailability = 'GOVERNED_DRAFTS' | 'ANSWERS' | 'PLANNED';

export interface HonCapability {
  readonly label: string;
  readonly state: HonCapabilityState;
  /** Existing authorized staff workspace for an AVAILABLE capability. */
  readonly href?: string;
}

export interface HonWorkflowEntry {
  readonly label: string;
  /** Existing conventional human workflow. Opening it never invokes an agent. */
  readonly href: string;
}

export interface HonCommandAgent {
  readonly id: HonAiTeamId;
  readonly name: string;
  readonly title: string;
  readonly signal: string;
  readonly color: string;
  readonly portrait: string;
  readonly purpose: string;
  readonly availability: HonAgentAvailability;
  readonly capabilities: readonly HonCapability[];
  readonly workflows: readonly HonWorkflowEntry[];
  readonly approval: string;
  /** Governed draft workspace that already exists for this agent. */
  readonly workspace: { readonly href: string; readonly label: string } | null;
  /** Requester-scoped durable draft records that genuinely belong to this agent. */
  readonly draftWorkKey: Exclude<AiDraftWorkAgentKey, 'claire'> | null;
}

type Definition = Omit<HonCommandAgent, 'name' | 'title' | 'signal' | 'color' | 'portrait'>;

const PLANNED_APPROVAL = 'No AI work is available yet. When a governed contract exists, consequential work will still require a qualified human approval in Action Center.';
const ANSWER_APPROVAL = 'Answers only: it reads this school’s own aggregate numbers and gives the recorded facts and a view. It never drafts, sends, schedules, charges or changes anything; any next step is yours to take.';
const MAYA_APPROVAL = 'Answers only: she reads this school’s attendance, rank, billing and term signals with your own access and suggests a check-in message. She never sends, schedules, books, charges or changes anything; you decide whether to reach out.';
const DRAFT_APPROVAL = 'Every draft becomes a CONFIRM proposal. A different qualified human must approve the exact payload in Action Center; approval never sends, publishes or delivers anything.';

const DEFINITIONS: readonly Definition[] = [
  {
    id: 'alex',
    purpose: 'Owner’s right hand and coordinator of the AI management team.',
    availability: 'ANSWERS',
    capabilities: [
      { label: 'Whole-school view and weekly priorities from verified facts (Ask HON → Alex)', state: 'AVAILABLE' },
      { label: 'Coordinate and delegate work across the team', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'School Command Center', href: '/staff/command-center' },
      { label: 'Human approvals', href: '/staff/action-center/approvals' },
      { label: 'Human work items', href: '/staff/work' },
    ],
    approval: ANSWER_APPROVAL,
    workspace: null,
    draftWorkKey: null,
  },
  {
    id: 'chad',
    purpose: 'Leads, trials, follow-up, enrollment and conversion.',
    availability: 'GOVERNED_DRAFTS',
    capabilities: [
      { label: 'Prepare a follow-up draft for a known CRM lead', state: 'AVAILABLE', href: '/staff/leads/assistant' },
      { label: 'Send or schedule a follow-up message', state: 'BACKEND_REQUIRED' },
      { label: 'Book trials or change lead records', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'CRM leads', href: '/staff/crm/leads' },
      { label: 'Follow-ups', href: '/staff/crm/follow-ups' },
      { label: 'Trial appointments', href: '/staff/crm/trials' },
    ],
    approval: DRAFT_APPROVAL,
    workspace: { href: '/staff/leads/assistant', label: 'Open Chad’s follow-up draft workspace' },
    draftWorkKey: 'chad',
  },
  {
    id: 'maya',
    purpose: 'Attendance, retention, student engagement, renewals and family success.',
    availability: 'ANSWERS',
    capabilities: [
      { label: 'At-risk students with reasons and one suggested next step (read only)', state: 'AVAILABLE', href: '/staff/retention/at-risk' },
      { label: 'Explain one at-risk student and suggest a check-in message you can send yourself (Ask Maya)', state: 'AVAILABLE', href: '/staff/retention/at-risk' },
      { label: 'Send, schedule or track outreach', state: 'BACKEND_REQUIRED' },
      { label: 'Renewal preparation', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'At-risk students', href: '/staff/retention/at-risk' },
      { label: 'Retention review', href: '/staff/retention/review' },
      { label: 'Attendance', href: '/staff/attendance' },
      { label: 'Renewal reviews', href: '/staff/billing/renewals' },
    ],
    approval: MAYA_APPROVAL,
    workspace: null,
    draftWorkKey: null,
  },
  {
    id: 'marcus',
    purpose: 'Campaigns, lead generation, growth and marketing performance.',
    availability: 'GOVERNED_DRAFTS',
    capabilities: [
      { label: 'Draft content for an existing school campaign', state: 'AVAILABLE', href: '/staff/marketing/assistant' },
      { label: 'Publish, advertise or spend', state: 'BACKEND_REQUIRED' },
      { label: 'Marketing performance analysis', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'Campaigns', href: '/staff/marketing/campaigns' },
      { label: 'Lead forms', href: '/staff/marketing/forms' },
    ],
    approval: DRAFT_APPROVAL,
    workspace: { href: '/staff/marketing/assistant', label: 'Open Marcus’s marketing draft workspace' },
    draftWorkKey: 'marcus',
  },
  {
    id: 'jordan',
    purpose: 'School operations, schedules, tasks and operational coordination.',
    availability: 'ANSWERS',
    capabilities: [
      { label: 'Class schedule, capacity, instructor coverage and attendance analysis (Ask HON → Jordan)', state: 'AVAILABLE' },
      { label: 'Operational task follow-through', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'Class sessions', href: '/staff/schedule/sessions' },
      { label: 'Team availability', href: '/staff/team/availability' },
      { label: 'Human work items', href: '/staff/work' },
    ],
    approval: ANSWER_APPROVAL,
    workspace: null,
    draftWorkKey: null,
  },
  {
    id: 'claire',
    purpose: 'Reporting, business intelligence, performance analysis and recommendations.',
    availability: 'ANSWERS',
    capabilities: [
      { label: 'Business performance analysis from verified school metrics (Ask HON → Claire)', state: 'AVAILABLE' },
      { label: 'KPI reports and dashboards', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'Operations dashboard', href: '/staff/dashboard' },
      { label: 'School health score', href: '/staff/health-score' },
      { label: 'Revenue planning', href: '/staff/planning/revenue' },
    ],
    approval: ANSWER_APPROVAL,
    workspace: null,
    // Deliberately null: historical `claire`-keyed records are teaching drafts.
    draftWorkKey: null,
  },
  {
    id: 'lena',
    purpose: 'Creative assets, campaigns, merchandise concepts and commerce presentation.',
    availability: 'ANSWERS',
    capabilities: [
      { label: 'Campaign, plan catalog and Creative Studio analysis (Ask HON → Lena)', state: 'AVAILABLE' },
      { label: 'Merchandise and commerce presentation drafts', state: 'BACKEND_REQUIRED' },
    ],
    workflows: [
      { label: 'Campaigns', href: '/staff/marketing/campaigns' },
      { label: 'Membership plans', href: '/staff/billing/membership-plans' },
    ],
    approval: ANSWER_APPROVAL,
    workspace: null,
    draftWorkKey: null,
  },
];

export const HON_COMMAND_ROSTER: readonly HonCommandAgent[] = HON_AI_TEAM.map((member) => {
  const definition = DEFINITIONS.find((item) => item.id === member.id);
  if (!definition) throw new Error(`HON command roster is missing ${member.id}.`);
  return { ...definition, name: member.name, title: member.title, signal: member.signal, color: member.color, portrait: member.portrait };
});

export function honAgent(id: string | null | undefined): HonCommandAgent | null {
  return HON_COMMAND_ROSTER.find((agent) => agent.id === id) ?? null;
}

/**
 * Durable draft-work sources as they were recorded. The `claire` key predates the
 * approved roster: those records are curriculum/teaching drafts from the Teaching
 * Assistant slice, NOT Business Performance work. The historical meaning is kept
 * and shown under a neutral legacy label so Claire's identity is not misstated.
 */
export const HON_DRAFT_WORK_SOURCES: Readonly<Record<AiDraftWorkAgentKey, { label: string; detail: string; destination: string; agentId: HonAiTeamId | null }>> = {
  chad: { label: 'Chad · Follow-up draft', detail: 'CRM follow-up content proposal', destination: '/staff/leads/assistant', agentId: 'chad' },
  marcus: { label: 'Marcus · Marketing draft', detail: 'Campaign content proposal', destination: '/staff/marketing/assistant', agentId: 'marcus' },
  claire: { label: 'Teaching draft assistant (legacy)', detail: 'Curriculum teaching draft recorded under a legacy key; not Claire’s Business Performance work', destination: '/staff/teaching-assistant', agentId: null },
};

/** Known Action Engine proposal codes from the existing governed draft slices. */
export function approvalSourceLabel(actionCode: string): string {
  if (actionCode === 'crm.follow_up_draft.propose') return 'Chad · Follow-up draft';
  if (actionCode === 'marketing.draft.save') return 'Marcus · Marketing draft';
  if (actionCode === 'teaching.draft.save') return 'Teaching draft assistant (legacy)';
  return 'School workflow';
}

/** Command Center recommendation ids mapped to the team area they concern (presentation only). */
export const HON_RECOMMENDATION_AREAS: Readonly<Record<string, HonAiTeamId>> = {
  REVIEW_PENDING_APPROVALS: 'alex',
  REVIEW_OUTSTANDING_WORK: 'jordan',
  PREPARE_UPCOMING_TRIALS: 'chad',
  REVIEW_NEW_LEADS: 'chad',
  PREPARE_MEMBERSHIP_RENEWALS: 'maya',
};

/** Same-origin return targets for the full workspace. A URL value is never authority. */
export function safeHonReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 80 || !/^\/staff(?:\/[a-z0-9-]+)*$/.test(value) || value.startsWith('/staff/hon')) return '/staff/dashboard';
  return value;
}

/**
 * Owner decision 2026-10-24: teaching and curriculum support is a separate
 * instructional AI, not Claire or Jordan and not one of the seven management
 * employees. Deliberately NOT added to the protected HON_AI_TEAM catalog: the
 * name is provisional, and its authorization,
 * catalog entry and contracts belong to the backend. Display only; the legacy
 * `claire` teaching records stay under their own historical label above.
 */
export const HON_TEACHING_AI = {
  name: 'Kai',
  title: 'Teaching & Curriculum AI',
  /** Default (realistic) portrait; see HON_TEACHING_AI_PORTRAITS for the per-mode styles. */
  portrait: '/ai/kai.webp',
  color: '#4f8dff',
  purpose: 'Planned instructional assistant for school owners and individually authorized instructors, with its own access separate from the management team.',
  boundary: 'Kai will never mark student proficiency, promotions, testing results or curriculum completion. Those stay instructor decisions recorded in the existing workflows.',
  tools: [
    { label: 'Teaching Studio', href: '/staff/teaching-studio' },
    { label: 'Curriculum library', href: '/staff/curriculum/library' },
    { label: 'Curriculum progress', href: '/staff/curriculum/progress' },
    { label: 'Scheduled classes', href: '/staff/schedule/sessions' },
    { label: 'Teaching draft assistant (legacy)', href: '/staff/teaching-assistant' },
  ],
} as const;

/**
 * Owner-approved Kai styles (2026-10-25), one per presentation mode: realistic
 * for Modern, illustrated for Classic, chibi for Big-Button. Same character in
 * each. Presentation only: the mode never grants or limits anything.
 */
export const HON_TEACHING_AI_PORTRAITS: Readonly<Record<HonInterfaceTheme, string>> = {
  modern: '/ai/kai.webp',
  classic: '/ai/kai-illustrated.webp',
  'big-button': '/ai/kai-chibi.webp',
};

/** Kai's portrait for a presentation mode; anything unrecognized falls back to the default style. */
export function teachingAiPortrait(theme: unknown): string {
  return typeof theme === 'string' && Object.hasOwn(HON_TEACHING_AI_PORTRAITS, theme)
    ? HON_TEACHING_AI_PORTRAITS[theme as HonInterfaceTheme]
    : HON_TEACHING_AI.portrait;
}

/**
 * Owner direction (2026-11-06): the team's art style is the viewer's own choice, separate
 * from the presentation mode. Realistic, illustrated and chibi exist for Kai and for each of
 * the seven specialists. Presentation only: a portrait never says an agent is available,
 * which only AI team readiness can say.
 */
export type HonArtStyle = 'realistic' | 'illustrated' | 'chibi';
export const HON_ART_STYLES: readonly HonArtStyle[] = ['realistic', 'illustrated', 'chibi'];
const ART_STYLE_SUFFIX: Readonly<Record<HonArtStyle, string>> = { realistic: '', illustrated: '-illustrated', chibi: '-chibi' };
const AI_TEAM_IDS: ReadonlySet<string> = new Set(['alex', 'chad', 'maya', 'marcus', 'jordan', 'claire', 'lena']);

export function isHonArtStyle(value: unknown): value is HonArtStyle {
  return typeof value === 'string' && (HON_ART_STYLES as readonly string[]).includes(value);
}

/** The style each mode starts with until the viewer picks one: Kai's original owner-approved pairing. */
export function defaultArtStyle(theme: unknown): HonArtStyle {
  return theme === 'classic' ? 'illustrated' : theme === 'big-button' ? 'chibi' : 'realistic';
}

/** Kai or a specialist in an art style; an unknown agent gets no portrait, an unknown style the realistic one. */
export function aiTeamPortrait(id: string, style: unknown): string | null {
  if (id !== 'kai' && !AI_TEAM_IDS.has(id)) return null;
  return `/ai/${id}${ART_STYLE_SUFFIX[isHonArtStyle(style) ? style : 'realistic']}.webp`;
}

/** The HON core orb (generated 2026-11-06), used wherever HON itself is shown. Presentation only. */
export const HON_CORE_SOURCE = '/ai/hon-core.webp';
