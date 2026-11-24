import type { ParentJourneyView } from '@hon/contracts/parent-journey-view';
import type { ParentBillingView } from '@hon/contracts/parent-billing-view';
import type { ParentTestingStatusView } from '@hon/contracts/parent-testing-status';
import type { ParentFamilyMessages } from '@hon/contracts/family-messages';
import { bookingLabel, formatClassTime, requirementCounts } from '../home/model';
import { CANDIDATE_LABEL, formatDay, formatMoney, openInvoices } from '../more/more-model';

/**
 * Eian, guided mode. Eian answers only from verified HON reads that the parent's own session returned, and it never
 * acts: anything that changes a record is handed to the normal screen, where the parent confirms it. There is no AI
 * provider and no free text generation here; every sentence is built from a record or is a fixed sentence below.
 */
export type EianIntent = 'next-class' | 'schedule' | 'belt' | 'testing' | 'billing' | 'messages' | 'absence' | 'book' | 'help';
export type EianTab = 'Schedule' | 'Messages' | 'More';
export interface EianAnswer { intent: EianIntent; lines: string[]; source: string | null; action?: { label: string; tab: EianTab } }

/** Which records an intent needs. The screen loads them with the parent's own session before answering. */
export const NEEDS: Record<EianIntent, ('billing' | 'testing' | 'messages')[]> = {
  'next-class': [], schedule: [], belt: [], testing: ['testing'], billing: ['billing'], messages: ['messages'], absence: [], book: [], help: [],
};

const RULES: [EianIntent, RegExp][] = [
  ['absence', /\b(absen\w*|miss(ing)?|sick|ill|can'?t (make|come|go)|won'?t (make|be))\b/],
  ['book', /\b(book|sign (him|her|them|up)|reserve|enrol+)\b/],
  ['billing', /\b(invoice\w*|bill\w*|owe|pay\w*|balance|membership|charge\w*|due)\b/],
  ['testing', /\b(test\w*|grading|exam)\b/],
  ['belt', /\b(belt|rank|stripe|requirement\w*|need\w* (for|to)|progress|curriculum)\b/],
  ['messages', /\b(message\w*|school (said|say|wrote)|reply|replied|inbox)\b/],
  ['next-class', /\bnext (class|lesson|session)\b|\bwhen is\b.*\bclass\b/],
  ['schedule', /\b(schedule|classes|this week|tomorrow|today|calendar)\b/],
];

export function classify(question: string): EianIntent {
  const q = question.toLowerCase();
  for (const [intent, rule] of RULES) if (rule.test(q)) return intent;
  return 'help';
}

const namedIn = (question: string, view: ParentJourneyView): number[] => {
  const q = question.toLowerCase();
  return view.children.map((ch, i) => [ch.name.toLowerCase().split(/\s+/)[0] ?? '', i] as const)
    .filter(([first]) => first.length > 1 && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)).map(([, i]) => i);
};

/** Children the question names (by first name), or all children when none is named. */
export function childrenFor(question: string, view: ParentJourneyView): number[] {
  const named = namedIn(question, view);
  return named.length ? named : view.children.map((_, i) => i);
}

/**
 * What Eian remembers from the last guided answer: the topic and the children it was about (full names, null when
 * the parent named none). It lives in the open screen only. It is never stored, never sent to HON or to an AI
 * provider, and it is gone when the parent leaves Eian.
 */
export interface EianMemory { intent: EianIntent; children: string[] | null }
export interface EianResolved { intent: EianIntent; children: number[]; followUp: boolean; memory: EianMemory | null }

const REFERS_BACK = /\b(he|she|they|him|her|them|his|hers|their|theirs)\b/;
const LEADS_ON = /^(and|also|what about|how about|same for|then|ok(ay)? (and|so)|so)\b/;

/**
 * Reads a question in the light of the last one. "And for Mia?" keeps the topic and changes the child; "when is his
 * next test?" changes the topic and keeps the child. A question that stands on its own is read on its own.
 * Remembered children are matched by name against the current view, so a child no longer shared is simply dropped.
 */
export function resolve(question: string, view: ParentJourneyView, last: EianMemory | null = null): EianResolved {
  const q = question.trim().toLowerCase();
  const own = classify(q);
  const named = namedIn(q, view);
  const all = view.children.map((_, i) => i);
  const linked = !!last && (REFERS_BACK.test(q) || LEADS_ON.test(q));
  const followUp = !!last && own === 'help' && (linked || (named.length > 0 && q.split(/\s+/).length <= 4));
  const intent = followUp ? last!.intent : own;
  const kept = last?.children ? all.filter(i => last.children!.includes(view.children[i]!.name)) : [];
  const carried = !named.length && linked && kept.length > 0;
  const children = named.length ? named : carried ? kept : all;
  const memory: EianMemory | null = intent === 'help' ? last
    : { intent, children: named.length || carried ? children.map(i => view.children[i]!.name) : null };
  return { intent, children, followUp, memory };
}

export interface EianFacts {
  journey: ParentJourneyView; timeZone: string | null; now: Date;
  /** The last guided answer in this conversation, when there was one. */
  last?: EianMemory | null;
  billing?: ParentBillingView | null; testing?: ParentTestingStatusView | null; messages?: ParentFamilyMessages | null;
}

const HELP = 'I can tell you about your next class, this week\'s schedule, belt requirements, belt testing, invoices and messages from your school. I can also take you to report an absence or book a class.';

export function answer(question: string, facts: EianFacts): EianAnswer {
  const { journey, timeZone, now } = facts;
  const read = resolve(question, journey, facts.last ?? null);
  const intent = read.intent;
  const kids = read.children.map(i => journey.children[i]!);
  const some = kids.length < journey.children.length;
  const upcoming = kids.flatMap(ch => ch.schedule.status === 'AVAILABLE'
    ? ch.schedule.items.filter(b => Date.parse(b.startsAt) > now.getTime() && b.bookingStatus !== 'CANCELLED' && b.sessionStatus !== 'CANCELLED').map(b => ({ ch, b })) : [])
    .sort((x, y) => Date.parse(x.b.startsAt) - Date.parse(y.b.startsAt));

  switch (intent) {
    case 'next-class': {
      const first = upcoming[0];
      if (!first) return { intent, lines: ['I don\'t see an upcoming class in the next four weeks.'], source: 'Your class schedule', action: { label: 'Book a class', tab: 'Schedule' } };
      return { intent, source: 'Your class schedule', lines: [`${first.ch.name}'s next class is ${first.b.name} on ${formatClassTime(first.b.startsAt, timeZone).text}${first.b.room ? `, in ${first.b.room}` : ''}. Status: ${bookingLabel(first.b.bookingStatus)}.`] };
    }
    case 'schedule': {
      const week = upcoming.filter(x => Date.parse(x.b.startsAt) < now.getTime() + 7 * 86_400_000);
      if (!week.length) return { intent, lines: ['No classes in the next 7 days.'], source: 'Your class schedule', action: { label: 'Open schedule', tab: 'Schedule' } };
      return { intent, source: 'Your class schedule', action: { label: 'Open schedule', tab: 'Schedule' },
        lines: week.slice(0, 8).map(x => `${formatClassTime(x.b.startsAt, timeZone).text}: ${x.b.name} (${x.ch.name}, ${bookingLabel(x.b.bookingStatus).toLowerCase()})`) };
    }
    case 'belt': {
      const lines = kids.flatMap(ch => {
        if (!ch.programs.length) return [`${ch.name}: no program progress is shared yet.`];
        return ch.programs.map(p => {
          const n = requirementCounts(p);
          const left = p.requirements.status === 'AVAILABLE' ? p.requirements.items.filter(r => r.required && r.status !== 'MET').map(r => r.label) : [];
          const head = `${ch.name}, ${p.name}${p.rank ? ` (${p.rank})` : ''}: ${n.available ? `${n.met} of ${n.total} requirements met` : 'requirements are not shared right now'}.`;
          return left.length ? `${head} Still to do: ${left.slice(0, 5).join(', ')}${left.length > 5 ? ', and more' : ''}.` : head;
        });
      });
      return { intent, lines, source: 'Your school\'s progress records' };
    }
    case 'testing': {
      const view = facts.testing;
      if (!view) return { intent, lines: ['I can\'t see belt testing records right now.'], source: null };
      // The testing read names children on its own, so a narrowed question is matched by name; no match shows everyone.
      const wanted = some ? view.children.items.filter(ch => kids.some(k => k.name === ch.displayName)) : [];
      const lines = (wanted.length ? wanted : view.children.items).map(ch => {
        const last = [...ch.candidates.items].sort((a, b) => Date.parse(b.event.startsAt) - Date.parse(a.event.startsAt))[0];
        const next = ch.upcomingEvent ? `next test is ${ch.upcomingEvent.label} on ${formatDay(ch.upcomingEvent.startsAt, timeZone)}` : 'no upcoming test is scheduled';
        return `${ch.displayName}: ${next}.${last ? ` Last result: ${CANDIDATE_LABEL[last.overallStatus].toLowerCase()} (${last.event.label}).` : ''}`;
      });
      return { intent, lines: lines.length ? lines : ['No belt testing on your account yet.'], source: 'Your school\'s testing records', action: { label: 'Open belt testing', tab: 'More' } };
    }
    case 'billing': {
      const view = facts.billing;
      if (!view) return { intent, lines: ['I can\'t see billing records right now.'], source: null };
      if (view.invoices.status !== 'AVAILABLE') return { intent, lines: ['Your school has not confirmed you as the billing contact, so I can\'t show invoices.'], source: 'Your school\'s billing records' };
      const open = openInvoices(view.invoices.items);
      if (!open.length) return { intent, lines: ['You have no open invoices.'], source: 'Your school\'s billing records', action: { label: 'Open billing', tab: 'More' } };
      return { intent, source: 'Your school\'s billing records', action: { label: 'Open billing', tab: 'More' },
        lines: [`You have ${open.length} open ${open.length === 1 ? 'invoice' : 'invoices'}:`, ...open.slice(0, 5).map(i => `${formatMoney(i.totalMinor, i.currency)} for ${i.participant.displayName}${i.dueAt ? `, due ${formatDay(i.dueAt, timeZone)}` : ''}.`),
          'Paying happens with your school. I can\'t take payments.'] };
    }
    case 'messages': {
      const view = facts.messages;
      if (!view) return { intent, lines: ['I can\'t see your messages right now.'], source: null };
      const last = [...view.messages].reverse().find(m => m.from === 'SCHOOL');
      return { intent, source: 'Your messages with the school', action: { label: 'Open messages', tab: 'Messages' },
        lines: [last ? `The latest message from ${view.schoolName}: "${last.body.length > 240 ? `${last.body.slice(0, 240)}…` : last.body}"` : `There are no messages from ${view.schoolName} yet.`] };
    }
    case 'absence':
      return { intent, source: null, action: { label: 'Report an absence', tab: 'Schedule' },
        lines: ['I can take you to report an absence. You pick the child and the day, and nothing is sent until you tap Send. Your school reviews every request.'] };
    case 'book':
      return { intent, source: null, action: { label: 'Book a class', tab: 'Schedule' },
        lines: ['I can take you to booking. You choose the class, and nothing is booked until you confirm.'] };
    default:
      return { intent: 'help', lines: [HELP], source: null };
  }
}

export const SUGGESTIONS = ["When is the next class?", 'What\'s on this week?', 'What does my child need for the next belt?', 'When is the next belt test?', 'Do we have any open invoices?', 'What did the school say?', 'Report an absence'];
