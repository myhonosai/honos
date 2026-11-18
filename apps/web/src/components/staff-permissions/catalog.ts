/**
 * Roles & permissions (owner 2026-11-16, "under staff, there should be setting to give permission to staff").
 * The 0412 read lists the permissions the signed-in manager may put in a custom role; this file turns each code into a
 * plain name and an area so the page shows a checklist instead of typed codes. Labels are display only: the server
 * decides what can be given, and a code with no label here still shows, by its stored description.
 */
export type AssignablePermission = Readonly<{ code: string; description: string; sensitive: boolean }>;
export const PERMISSION_LIST_LIMIT = 200;
const CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** 0412 response check. A row with an unexpected shape is left out (never guessed); a bad envelope fails the read. */
export function verifyAssignablePermissions(value: unknown): AssignablePermission[] {
  if (!Array.isArray(value) || value.length > PERMISSION_LIST_LIMIT) throw new Error('The permission list could not be verified.');
  const seen = new Set<string>(), rows: AssignablePermission[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    if (Object.keys(r).sort().join('|') !== 'code|description|sensitive') continue;
    if (typeof r.code !== 'string' || r.code.length > 100 || !CODE.test(r.code) || /^(hq|platform|system)\./.test(r.code) || seen.has(r.code)) continue;
    if (typeof r.description !== 'string' || !r.description.trim() || r.description.length > 300 || typeof r.sensitive !== 'boolean') continue;
    seen.add(r.code); rows.push(Object.freeze({ code: r.code, description: r.description, sensitive: r.sensitive }));
  }
  return rows;
}

/** Areas follow the school app menu headings, in menu order. */
export const PERMISSION_AREAS: readonly Readonly<{ key: string; label: string; prefixes: readonly string[] }>[] = [
  { key: 'general', label: 'General', prefixes: ['school', 'search', 'settings'] },
  { key: 'ai', label: 'AI team', prefixes: ['ai', 'action', 'knowledge', 'automation'] },
  { key: 'calendar', label: 'Calendar & classes', prefixes: ['schedule', 'program'] },
  { key: 'attendance', label: 'Attendance', prefixes: ['attendance'] },
  { key: 'contacts', label: 'Contacts & students', prefixes: ['people', 'family', 'student', 'document'] },
  { key: 'staff', label: 'Staff', prefixes: ['iam', 'staff', 'work_item'] },
  { key: 'leads', label: 'Leads', prefixes: ['crm', 'migration'] },
  { key: 'communication', label: 'Texts & email', prefixes: ['communication'] },
  { key: 'finance', label: 'Finance', prefixes: ['billing', 'planning'] },
  { key: 'marketing', label: 'Marketing', prefixes: ['marketing'] },
  { key: 'ranks', label: 'Ranks & tests', prefixes: ['curriculum', 'testing', 'teaching', 'achievement'] },
  { key: 'business', label: 'Business & reports', prefixes: ['reporting', 'retention'] },
  { key: 'community', label: 'Community', prefixes: ['champions'] },
];
const OTHER = { key: 'other', label: 'Other', prefixes: [] as string[] };
export function areaOf(code: string): Readonly<{ key: string; label: string }> {
  const head = code.split('.')[0]!;
  return PERMISSION_AREAS.find(a => a.prefixes.includes(head)) ?? OTHER;
}

/** Plain names for the permissions people pick most. Anything else shows its stored description. */
export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'school.view': 'See this school in HON',
  'search.global': 'Search across the school',
  'attendance.record': 'Take attendance, including scan check-in',
  'attendance.cards.manage': 'Attendance cards: choose the look, print, cancel, record photo consent',
  'schedule.session.manage': 'Set up classes on the calendar',
  'schedule.session.read': 'See the class calendar',
  'schedule.booking.manage': 'Book students into classes',
  'schedule.planned_absence.review': 'Review planned absences',
  'program.manage': 'Manage programs',
  'people.read': 'See contacts',
  'people.create': 'Add contacts',
  'family.read': 'See families',
  'family.create': 'Add families',
  'family.manage': 'Edit families',
  'family.member.manage': 'Edit family members',
  'student.enroll': 'Enroll students',
  'iam.staff_role.manage': 'Open Roles & permissions',
  'iam.custom_role.create': 'Make new roles',
  'iam.custom_role.update': 'Change roles',
  'iam.staff_role.grant': 'Give a role to a person',
  'iam.staff_role.revoke': 'End a person’s role',
  'staff.availability.manage': 'Manage staff availability',
  'staff.shift.manage': 'Schedule staff shifts',
  'staff.shift.view_own': 'See their own shifts',
  'staff.availability.self_manage': 'Set their own availability',
  'staff.instructor_qualification.read': 'See instructor qualifications',
  'staff.instructor_qualification.manage': 'Record instructor qualifications',
  'work_item.read': 'See tasks',
  'work_item.create': 'Create tasks',
  'work_item.manage': 'Manage everyone’s tasks',
  'work_item.self_manage': 'Manage their own tasks',
  'crm.lead.read': 'See leads',
  'crm.lead.create': 'Add leads',
  'crm.lead.register': 'Register a lead as a member',
  'crm.lead.close': 'Close leads',
  'crm.pipeline.manage': 'Edit the lead pipeline',
  'crm.trial.schedule': 'Book trial classes',
  'crm.trial.manage': 'Manage trial classes',
  'crm.follow_up.manage': 'Manage everyone’s follow-ups',
  'crm.follow_up.self_manage': 'Manage their own follow-ups',
  'crm.lead.follow_up.send': 'Send lead follow-ups',
  'communication.message.read': 'Read texts and email',
  'communication.message.create': 'Write texts and email',
  'communication.message.queue': 'Send texts and email',
  'communication.consent.read': 'See message consent',
  'communication.consent.manage': 'Record message consent',
  'billing.account.create': 'Open billing accounts',
  'billing.invoice.create': 'Create invoices',
  'billing.invoice.issue': 'Send invoices',
  'billing.payment.initiate': 'Take payments',
  'billing.refund.create': 'Give refunds',
  'billing.membership.read': 'See memberships',
  'billing.membership.create': 'Create memberships',
  'billing.membership.activate': 'Start memberships',
  'billing.membership.cancel': 'Cancel memberships',
  'marketing.campaign.read': 'See marketing campaigns',
  'marketing.campaign.create': 'Create marketing campaigns',
  'marketing.social.publish': 'Post to social media',
  'curriculum.manage': 'Edit the curriculum',
  'curriculum.rank.manage': 'Set up ranks',
  'curriculum.progress.record': 'Record student progress',
  'testing.event.manage': 'Set up belt tests',
  'testing.candidate.manage': 'Register students for tests',
  'testing.candidate.grade': 'Grade tests',
  'testing.promotion.decide': 'Promote students',
  'testing.certificate.issue': 'Issue certificates',
  'reporting.view': 'See reports',
  'action.approve': 'Approve AI team actions',
  'ai.team.configure': 'Set up the AI team',
  'ai.usage.read': 'See AI usage',
  'teaching.journal.use': 'Keep their own Kai teaching journal',
};
export const labelOf = (p: AssignablePermission): string => PERMISSION_LABELS[p.code] ?? p.description;

/** The checklist rows grouped by area, in menu order, each area sorted by label. */
export function groupPermissions(list: readonly AssignablePermission[]): Readonly<{ key: string; label: string; items: readonly AssignablePermission[] }>[] {
  const order = [...PERMISSION_AREAS, OTHER];
  return order.map(area => ({ key: area.key, label: area.label,
    items: list.filter(p => areaOf(p.code).key === area.key).sort((a, b) => labelOf(a).localeCompare(labelOf(b))) }))
    .filter(group => group.items.length > 0);
}
