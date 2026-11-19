import {
  validateAutomationDefinition, type AutomationDefinition, type AutomationTriggerKind, type AutomationWorkflowCondition, type AutomationWorkflowStep,
} from '@hon/contracts';

/**
 * The simple Automations setup: three plain questions (when it starts, who it is for, what gets sent) that map one to one
 * onto the AU-1 workflow definition. The simple form only ever produces a straight line of steps (an optional wait, then
 * one send), and reads back only definitions of that same shape; anything else (branches, approvals, AI-written text)
 * opens as read-only. The server re-validates every definition; nothing here grants or sends anything.
 */

/** The starts a school can pick, in the order the menu shows them. Date starts carry a number; a tag start carries a tag. */
export const WHEN_KINDS = ['LEAD_CREATED', 'TRIAL_BOOKED', 'TRIAL_NO_SHOW', 'TRIAL_ATTENDED', 'MEMBERSHIP_ACTIVATED', 'ABSENT_DAYS', 'BIRTHDAY',
  'MEMBERSHIP_ENDS_IN_DAYS', 'MEMBERSHIP_CANCELLED', 'MEMBERSHIP_ANNIVERSARY', 'MISSED_CALL', 'TAG_ADDED'] as const satisfies readonly AutomationTriggerKind[];
export type WhenKind = typeof WHEN_KINDS[number];
export const WHEN_DAYS: Partial<Record<WhenKind, { min: number; max: number; fallback: number }>> = {
  ABSENT_DAYS: { min: 3, max: 365, fallback: 14 }, BIRTHDAY: { min: 0, max: 30, fallback: 0 }, MEMBERSHIP_ENDS_IN_DAYS: { min: 1, max: 180, fallback: 30 },
};
/** Starts that are about students (date starts reach everyone already matching on the day they are turned on). */
export const DATE_KINDS: readonly WhenKind[] = ['ABSENT_DAYS', 'BIRTHDAY', 'MEMBERSHIP_ENDS_IN_DAYS'];

export const GROUPS = ['EVERYONE', 'OPEN_LEADS', 'ACTIVE_STUDENTS'] as const;
export type Group = typeof GROUPS[number];
export const STOPS = ['TRIAL_BOOKED', 'REPLIED', 'ENROLLED', 'LEAD_CLOSED'] as const;
export type Stop = typeof STOPS[number];
export const CHANNELS = ['TEXT', 'EMAIL', 'TASK', 'NOTIFY'] as const;
export type Channel = typeof CHANNELS[number];
export const DELAY_UNITS = ['NOW', 'HOURS', 'DAYS'] as const;
export type DelayUnit = typeof DELAY_UNITS[number];
export const MERGE_FIELDS = ['first_name', 'school_name', 'staff_name'] as const;

export type Send = { channel: Channel; delayUnit: DelayUnit; delayAmount: number; subject: string; text: string; videoUrl: string };
export type SimpleAutomation = {
  name: string;
  when: WhenKind; days: number; tag: string;
  group: Group; onlyTag: string; stopWhen: Stop[]; repeat: boolean;
  sends: Send[];
};

export const MAX_SENDS = 12;
const TEXT_MAX: Record<Channel, number> = { TEXT: 1000, EMAIL: 4000, TASK: 120, NOTIFY: 500 };
const VIDEO_LINE = '\n\nWatch: ';
const VIDEO = /^https:\/\/[^\s{}<>"']{4,400}$/;
const TAG = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,38}[A-Za-z0-9])?$/;

export const blankSend = (channel: Channel = 'TEXT'): Send => ({ channel, delayUnit: 'NOW', delayAmount: 1, subject: '', text: '', videoUrl: '' });
export function blankAutomation(): SimpleAutomation {
  return { name: '', when: 'LEAD_CREATED', days: 14, tag: '', group: 'EVERYONE', onlyTag: '', stopWhen: [], repeat: false, sends: [blankSend()] };
}

/** Minutes a send waits after the previous one. */
export function delayMinutes(send: Send): number {
  if (send.delayUnit === 'NOW') return 0;
  return send.delayAmount * (send.delayUnit === 'HOURS' ? 60 : 1440);
}

function messageText(send: Send): string {
  const text = send.text.trim();
  if ((send.channel === 'TEXT' || send.channel === 'EMAIL') && send.videoUrl.trim()) return `${text}${VIDEO_LINE}${send.videoUrl.trim()}`;
  return text;
}

/** Plain problems with the form, in the order they appear on the page. An empty list means it can be saved. */
export type Problem = 'name' | 'days' | 'tag' | 'onlyTag' | 'sends' | `send${number}.text` | `send${number}.subject` | `send${number}.delay` | `send${number}.video`;
export function problems(a: SimpleAutomation): Problem[] {
  const out: Problem[] = [];
  const name = a.name.trim();
  if (!name || [...name].length > 100 || /[\t\n\r{}]/.test(name)) out.push('name');
  const range = WHEN_DAYS[a.when];
  if (range && !(Number.isInteger(a.days) && a.days >= range.min && a.days <= range.max)) out.push('days');
  if (a.when === 'TAG_ADDED' && !TAG.test(a.tag.trim())) out.push('tag');
  if (a.onlyTag.trim() && !TAG.test(a.onlyTag.trim())) out.push('onlyTag');
  if (a.sends.length < 1 || a.sends.length > MAX_SENDS) out.push('sends');
  a.sends.forEach((s, i) => {
    const text = messageText(s);
    if (!s.text.trim() || [...text].length > TEXT_MAX[s.channel] || !mergeOk(text)) out.push(`send${i}.text`);
    if (s.channel === 'EMAIL' && (!s.subject.trim() || [...s.subject.trim()].length > 150 || !mergeOk(s.subject.trim()))) out.push(`send${i}.subject`);
    if (s.delayUnit !== 'NOW' && !(Number.isInteger(s.delayAmount) && s.delayAmount >= 1 && delayMinutes(s) <= 525600)) out.push(`send${i}.delay`);
    if (s.videoUrl.trim() && !VIDEO.test(s.videoUrl.trim())) out.push(`send${i}.video`);
  });
  return out;
}
/** Every {{...}} must be one of the merge fields the server knows. */
export function mergeOk(text: string): boolean {
  return !/(\{\{|\}\})/.test(text.replace(/\{\{(first_name|school_name|program_name|trial_time|booking_link|staff_name)\}\}/g, ''));
}

function trigger(a: SimpleAutomation): AutomationDefinition['trigger'] {
  switch (a.when) {
    case 'ABSENT_DAYS': case 'MEMBERSHIP_ENDS_IN_DAYS': return { kind: a.when, config: { days: a.days } };
    case 'BIRTHDAY': return { kind: a.when, config: { daysBefore: a.days } };
    case 'TAG_ADDED': return { kind: a.when, config: { tag: a.tag.trim() } };
    default: return { kind: a.when, config: {} };
  }
}

/** The AU-1 definition for a simple automation: entry rules from "who", exits from "stop when", and a straight line of steps. */
export function toDefinition(a: SimpleAutomation): AutomationDefinition {
  const conditions: AutomationWorkflowCondition[] = [];
  if (a.group === 'OPEN_LEADS') conditions.push({ kind: 'LEAD_IS_OPEN', negate: false });
  if (a.group === 'ACTIVE_STUDENTS') conditions.push({ kind: 'IS_ACTIVE_STUDENT', negate: false });
  if (a.onlyTag.trim()) conditions.push({ kind: 'HAS_TAG', negate: false, tag: a.onlyTag.trim() });
  const ids: string[] = [];
  a.sends.forEach((s, i) => { if (delayMinutes(s) > 0) ids.push(`wait_${i + 1}`); ids.push(`send_${i + 1}`); });
  const next = (id: string): string | null => ids[ids.indexOf(id) + 1] ?? null;
  const steps: AutomationWorkflowStep[] = [];
  a.sends.forEach((s, i) => {
    const minutes = delayMinutes(s);
    if (minutes > 0) steps.push({ id: `wait_${i + 1}`, type: 'WAIT', minutes, localTime: null, next: next(`wait_${i + 1}`) });
    const id = `send_${i + 1}`, text = messageText(s);
    if (s.channel === 'TEXT') steps.push({ id, type: 'SEND_SMS', content: { mode: 'FIXED', text }, next: next(id) });
    if (s.channel === 'EMAIL') steps.push({ id, type: 'SEND_EMAIL', content: { mode: 'FIXED', subject: s.subject.trim(), text }, next: next(id) });
    if (s.channel === 'TASK') steps.push({ id, type: 'CREATE_TASK', title: text, details: '', dueInHours: 24, assignTo: a.group === 'ACTIVE_STUDENTS' ? 'SCHOOL_OWNERS' : 'LEAD_ASSIGNEE', next: next(id) });
    if (s.channel === 'NOTIFY') steps.push({ id, type: 'NOTIFY_STAFF', to: 'SCHOOL_OWNERS', text, next: next(id) });
  });
  return validateAutomationDefinition({
    schemaVersion: 1, trigger: trigger(a),
    entry: { reentry: a.repeat ? 'EVERY_TIME' : 'ONCE_EVER', reentryDays: null, conditions },
    exitWhen: STOPS.filter(s => a.stopWhen.includes(s)), steps,
  });
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Reads a saved definition back into the simple form, or null when it uses anything the simple form cannot show. */
export function fromDefinition(name: string, d: AutomationDefinition): SimpleAutomation | null {
  if (!(WHEN_KINDS as readonly string[]).includes(d.trigger.kind)) return null;
  const when = d.trigger.kind as WhenKind, config = d.trigger.config;
  const days = when === 'BIRTHDAY' ? config.daysBefore : when === 'ABSENT_DAYS' || when === 'MEMBERSHIP_ENDS_IN_DAYS' ? config.days : 14;
  const tag = when === 'TAG_ADDED' && typeof config.tag === 'string' ? config.tag : '';
  if (typeof days !== 'number') return null;
  if (d.entry.reentry === 'ONCE_PER_PERIOD') return null;
  let group: Group = 'EVERYONE', onlyTag = '';
  for (const c of d.entry.conditions) {
    if (c.negate) return null;
    if (c.kind === 'LEAD_IS_OPEN' && group === 'EVERYONE') group = 'OPEN_LEADS';
    else if (c.kind === 'IS_ACTIVE_STUDENT' && group === 'EVERYONE') group = 'ACTIVE_STUDENTS';
    else if (c.kind === 'HAS_TAG' && !onlyTag && typeof c.tag === 'string') onlyTag = c.tag;
    else return null;
  }
  if (d.exitWhen.some(x => !(STOPS as readonly string[]).includes(x))) return null;
  // Walk the straight line from the first step; every step must be reached exactly once.
  const byId = new Map(d.steps.map(s => [s.id, s]));
  const sends: Send[] = [];
  let at: AutomationWorkflowStep | undefined = d.steps[0], pending = 0, seen = 0;
  while (at) {
    seen++;
    const n = at.next;
    if (n !== null && typeof n !== 'string') return null;
    if (at.type === 'WAIT') {
      if (pending > 0 || typeof at.minutes !== 'number' || at.localTime !== null) return null;
      pending = at.minutes;
    } else {
      const send = readSend(at, pending);
      if (!send) return null;
      sends.push(send); pending = 0;
    }
    at = n === null ? undefined : byId.get(n);
    if (n !== null && !at) return null;
    if (seen > d.steps.length) return null;
  }
  if (seen !== d.steps.length || pending > 0 || sends.length === 0 || sends.length > MAX_SENDS) return null;
  return { name, when, days, tag, group, onlyTag, stopWhen: STOPS.filter(s => d.exitWhen.includes(s)), repeat: d.entry.reentry === 'EVERY_TIME', sends };
}

function readSend(step: AutomationWorkflowStep, wait: number): Send | null {
  const delay: Pick<Send, 'delayUnit' | 'delayAmount'> = wait === 0 ? { delayUnit: 'NOW', delayAmount: 1 }
    : wait % 1440 === 0 ? { delayUnit: 'DAYS', delayAmount: wait / 1440 } : wait % 60 === 0 ? { delayUnit: 'HOURS', delayAmount: wait / 60 } : { delayUnit: 'NOW', delayAmount: -1 };
  if (delay.delayAmount === -1) return null;
  const split = (text: string) => {
    const at = text.lastIndexOf(VIDEO_LINE);
    if (at < 0) return { text, videoUrl: '' };
    const url = text.slice(at + VIDEO_LINE.length);
    return VIDEO.test(url) ? { text: text.slice(0, at), videoUrl: url } : { text, videoUrl: '' };
  };
  const content = step.content;
  if (step.type === 'SEND_SMS' && obj(content) && content.mode === 'FIXED' && typeof content.text === 'string') return { channel: 'TEXT', ...delay, subject: '', ...split(content.text) };
  if (step.type === 'SEND_EMAIL' && obj(content) && content.mode === 'FIXED' && typeof content.text === 'string' && typeof content.subject === 'string') {
    return { channel: 'EMAIL', ...delay, subject: content.subject, ...split(content.text) };
  }
  if (step.type === 'CREATE_TASK' && typeof step.title === 'string' && step.details === '') return { channel: 'TASK', ...delay, subject: '', text: step.title, videoUrl: '' };
  if (step.type === 'NOTIFY_STAFF' && step.to === 'SCHOOL_OWNERS' && typeof step.text === 'string') return { channel: 'NOTIFY', ...delay, subject: '', text: step.text, videoUrl: '' };
  return null;
}

/** Starter automations. Wording is a starting point the school edits; nothing is saved or turned on until they press a button. */
export const TEMPLATE_KEYS = ['NO_SHOW', 'LEAD_NURTURE', 'MIA', 'BIRTHDAY', 'RENEWAL', 'WELCOME'] as const;
export type TemplateKey = typeof TEMPLATE_KEYS[number];
const s = (channel: Channel, delayUnit: DelayUnit, delayAmount: number, text: string, subject = ''): Send => ({ channel, delayUnit, delayAmount, subject, text, videoUrl: '' });
export const TEMPLATES: Record<TemplateKey, SimpleAutomation> = {
  NO_SHOW: { name: 'Trial no-show follow-up', when: 'TRIAL_NO_SHOW', days: 14, tag: '', group: 'OPEN_LEADS', onlyTag: '', stopWhen: ['TRIAL_BOOKED', 'REPLIED', 'ENROLLED', 'LEAD_CLOSED'], repeat: true, sends: [
    s('TEXT', 'HOURS', 2, 'Hi {{first_name}}, we missed you at your trial class today at {{school_name}}. Want to pick a new time? Just reply here.'),
    s('EMAIL', 'DAYS', 1, 'Hi {{first_name}},\n\nWe saved a spot for you and would love to see you on the mat. Reply to this email and we will find a time that works.\n\n{{school_name}}', 'Let us find you a new trial time'),
    s('TASK', 'DAYS', 2, 'Call {{first_name}} about a new trial time'),
  ] },
  LEAD_NURTURE: { name: 'New lead nurture', when: 'LEAD_CREATED', days: 14, tag: '', group: 'OPEN_LEADS', onlyTag: '', stopWhen: ['TRIAL_BOOKED', 'REPLIED', 'ENROLLED', 'LEAD_CLOSED'], repeat: false, sends: [
    s('TEXT', 'NOW', 1, 'Hi {{first_name}}, thanks for your interest in {{school_name}}! When would you like to try a free class? Reply here and we will set it up.'),
    s('EMAIL', 'DAYS', 1, 'Hi {{first_name}},\n\nHere is what your first class at {{school_name}} looks like: a warm welcome, a short warm-up, and a class built for beginners. Reply and we will book your free trial.\n\n{{school_name}}', 'Your first class at {{school_name}}'),
    s('TEXT', 'DAYS', 2, 'Hi {{first_name}}, just checking in. Do you have any questions about classes at {{school_name}}?'),
    s('EMAIL', 'DAYS', 4, 'Hi {{first_name}},\n\nWe would still love to meet you. Reply with a day that works and we will hold a spot in a beginner class.\n\n{{school_name}}', 'Still thinking about classes?'),
  ] },
  MIA: { name: 'Missing student check-in', when: 'ABSENT_DAYS', days: 14, tag: '', group: 'ACTIVE_STUDENTS', onlyTag: '', stopWhen: ['REPLIED'], repeat: true, sends: [
    s('TEXT', 'NOW', 1, 'Hi {{first_name}}, we have missed you in class at {{school_name}}! Is everything OK? We would love to see you back this week.'),
    s('NOTIFY', 'DAYS', 3, '{{first_name}} has not been to class in a while and has not replied. A personal call may help.'),
  ] },
  BIRTHDAY: { name: 'Happy birthday', when: 'BIRTHDAY', days: 0, tag: '', group: 'ACTIVE_STUDENTS', onlyTag: '', stopWhen: [], repeat: true, sends: [
    s('TEXT', 'NOW', 1, 'Happy birthday, {{first_name}}! Everyone at {{school_name}} hopes you have a great day.'),
  ] },
  RENEWAL: { name: 'Membership renewal reminder', when: 'MEMBERSHIP_ENDS_IN_DAYS', days: 30, tag: '', group: 'ACTIVE_STUDENTS', onlyTag: '', stopWhen: ['REPLIED'], repeat: true, sends: [
    s('EMAIL', 'NOW', 1, 'Hi {{first_name}},\n\nYour membership at {{school_name}} ends in about a month. We would love to keep training with you. Reply to this email and we will help you renew.\n\n{{school_name}}', 'Your membership is ending soon'),
    s('TEXT', 'DAYS', 14, 'Hi {{first_name}}, your membership at {{school_name}} ends soon. Want us to help you renew? Just reply here.'),
    s('TASK', 'DAYS', 7, 'Talk with {{first_name}} about renewing'),
  ] },
  WELCOME: { name: 'Welcome new member', when: 'MEMBERSHIP_ACTIVATED', days: 14, tag: '', group: 'EVERYONE', onlyTag: '', stopWhen: [], repeat: false, sends: [
    s('EMAIL', 'NOW', 1, 'Hi {{first_name}},\n\nWelcome to {{school_name}}! We are excited to train with you. Bring water, arrive a few minutes early, and ask us anything.\n\n{{school_name}}', 'Welcome to {{school_name}}'),
    s('TEXT', 'DAYS', 3, 'Hi {{first_name}}, how are your first classes going at {{school_name}}? Reply with any questions.'),
  ] },
};
export function fromTemplate(key: TemplateKey): SimpleAutomation {
  const t = TEMPLATES[key];
  return { ...t, stopWhen: [...t.stopWhen], sends: t.sends.map(x => ({ ...x })) };
}

/** Counts of each channel, for the one-line summary on a card. */
export function channelCounts(sends: readonly Send[]): Partial<Record<Channel, number>> {
  const out: Partial<Record<Channel, number>> = {};
  for (const x of sends) out[x.channel] = (out[x.channel] ?? 0) + 1;
  return out;
}
