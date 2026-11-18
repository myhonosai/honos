import { verifyParentJourneyView } from '@hon/contracts/parent-journey-view';
import { verifyParentClassBookingChoices, verifyParentClassBookingReceipt } from '@hon/contracts/parent-class-booking';
import { verifyFamilyMessageReceipt, verifyParentFamilyMessages } from '@hon/contracts/family-messages';
import { verifyParentPlannedAbsenceRequestContext, verifyParentPlannedAbsenceSubmittedReceipt } from '@hon/contracts/parent-planned-absence-request';
import { verifyParentBillingView } from '@hon/contracts/parent-billing-view';
import { verifyParentClassPassView } from '@hon/contracts/parent-classpass-view';
import { verifyParentTestingStatusView } from '@hon/contracts/parent-testing-status';
import { verifyParentCurriculumLibrary } from '@hon/contracts/curriculum-resource-library';
import { verifyParentInvoicePayments } from '@hon/contracts/parent-invoice-pay';
import type { ParentApi } from '../api/client';
import { localDate, localMidnight } from '../schedule/absence-model';

/**
 * SAMPLE FAMILY. A made-up family that lets someone tap through the app before signing in to a real school.
 * Nothing here talks to HON: there is no network call, no session and no real person. Every response still goes
 * through the same contract verifiers as live data, and every screen shows a SAMPLE banner while it is in use.
 * Changes (bookings, messages, absences) live only in memory and vanish when the sample is closed.
 */
export const SAMPLE_SCHOOL = 'Sample Martial Arts';
const ZONE = 'America/Los_Angeles';
const MIA = '5a3f0e21-0000-4000-8000-000000000001';
const LEO = '5a3f0e21-0000-4000-8000-000000000002';
const id = (n: number) => `5a3f0e21-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function createSampleApi(now: () => Date = () => new Date()): ParentApi {
  const start = now();
  const today = localDate(ZONE, start);
  const at = (days: number, hour: number, minute = 0) => {
    const date = new Date(Date.parse(`${today}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
    return new Date(localMidnight(ZONE, date).getTime() + (hour * 60 + minute) * 60_000).toISOString();
  };
  const plus = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();
  const ms = (iso: string) => new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString();

  // Bookable sessions over the next two weeks; Mia is already booked into some.
  type Session = { sessionId: string; child: string; name: string; programName: string; roomName: string | null; startsAt: string; spotsLeft: number; bookingId: string | null; version: number };
  const sessions: Session[] = [];
  let n = 100;
  for (let d = 0; d < 14; d++) {
    const weekday = new Date(Date.parse(`${today}T12:00:00Z`) + d * 86_400_000).getUTCDay();
    if (weekday === 1 || weekday === 3 || weekday === 5) {
      sessions.push({ sessionId: id(++n), child: MIA, name: 'Little Dragons', programName: 'Kids Program', roomName: 'Main mat', startsAt: at(d, 17, 30), spotsLeft: 4, bookingId: d < 7 ? id(500 + n) : null, version: 1 });
    }
    if (weekday === 2 || weekday === 4) {
      sessions.push({ sessionId: id(++n), child: LEO, name: 'Junior Warriors', programName: 'Junior Program', roomName: 'Studio B', startsAt: at(d, 18, 15), spotsLeft: weekday === 4 ? 0 : 6, bookingId: d < 7 ? id(500 + n) : null, version: 1 });
    }
    if (weekday === 6) {
      sessions.push({ sessionId: id(++n), child: MIA, name: 'Saturday Open Mat', programName: 'Kids Program', roomName: null, startsAt: at(d, 10), spotsLeft: 8, bookingId: null, version: 1 });
    }
  }
  const messages: { messageId: string; from: 'FAMILY' | 'SCHOOL'; mine: boolean; body: string; sentAt: string }[] = [
    { messageId: id(900), from: 'SCHOOL', mine: false, body: 'Welcome to Sample Martial Arts! Reply here any time with questions.', sentAt: ms(plus(start.toISOString(), -6 * 24 * 60)) },
    { messageId: id(901), from: 'FAMILY', mine: true, body: 'Thank you! Is there class on the holiday Monday?', sentAt: ms(plus(start.toISOString(), -2 * 24 * 60)) },
    { messageId: id(902), from: 'SCHOOL', mine: false, body: 'Yes, classes run as normal on Monday. See you there!', sentAt: ms(plus(start.toISOString(), -2 * 24 * 60 + 45)) },
  ];
  let messageVersion = 4;

  const journeyRaw = () => {
    const from = new Date(start.getTime() - 86_400_000).toISOString(), to = new Date(start.getTime() + 28 * 86_400_000).toISOString();
    const schedule = (child: string) => sessions.filter(s => s.child === child && s.bookingId).map(s => ({
      name: s.name, program: s.programName, startsAt: s.startsAt, endsAt: plus(s.startsAt, 45), room: s.roomName, bookingStatus: 'BOOKED', sessionStatus: 'SCHEDULED', kind: 'REGULAR',
    }));
    return {
      generatedAt: start.toISOString(), from, to, accessLevel: 'PRIMARY_GUARDIAN',
      children: [
        { name: 'Mia Sample', profileAvailable: true,
          programs: [{ name: 'Kids Program', rank: 'Yellow Belt', requirements: { status: 'AVAILABLE', limited: false, items: [
            { label: 'Front kick', kind: 'TECHNIQUE', required: true, status: 'MET', recordedAt: plus(start.toISOString(), -9 * 1440) },
            { label: 'Low block', kind: 'TECHNIQUE', required: true, status: 'MET', recordedAt: plus(start.toISOString(), -6 * 1440) },
            { label: 'Form 1', kind: 'TECHNIQUE', required: true, status: 'PRACTICING', recordedAt: plus(start.toISOString(), -2 * 1440) },
            { label: 'Board break', kind: 'TECHNIQUE', required: true, status: null, recordedAt: null },
            { label: 'Respect and focus', kind: 'CHARACTER', required: false, status: 'MET', recordedAt: plus(start.toISOString(), -4 * 1440) },
          ] } }],
          schedule: { status: 'AVAILABLE', limited: false, items: schedule(MIA) },
          achievements: { status: 'AVAILABLE', limited: false, items: [{ name: 'Perfect Attendance', description: 'Came to every class this month.', awardedOn: localDate(ZONE, new Date(start.getTime() - 5 * 86_400_000)) }] } },
        { name: 'Leo Sample', profileAvailable: true,
          programs: [{ name: 'Junior Program', rank: 'Orange Belt', requirements: { status: 'AVAILABLE', limited: false, items: [
            { label: 'Roundhouse kick', kind: 'TECHNIQUE', required: true, status: 'MET', recordedAt: plus(start.toISOString(), -12 * 1440) },
            { label: 'Form 2', kind: 'TECHNIQUE', required: true, status: 'MET', recordedAt: plus(start.toISOString(), -3 * 1440) },
            { label: 'Sparring basics', kind: 'TECHNIQUE', required: true, status: 'PRACTICING', recordedAt: plus(start.toISOString(), -1 * 1440) },
          ] } }],
          schedule: { status: 'AVAILABLE', limited: false, items: schedule(LEO) },
          achievements: { status: 'AVAILABLE', limited: false, items: [] } },
      ],
      documents: { status: 'AVAILABLE', limited: false, items: [{ title: 'Holiday schedule', publishedAt: plus(start.toISOString(), -3 * 1440) }] },
      documentReceipts: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' },
      plannedAbsences: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' },
    };
  };
  const booking = (s: Session) => s.bookingId ? { bookingId: s.bookingId, sessionId: s.sessionId, studentProfileId: s.child, status: 'BOOKED', source: 'PARENT_APP', version: s.version, canCancel: true } : null;
  const choicesRaw = () => ({
    canBook: true, timezone: ZONE, horizonDays: 14,
    children: [[MIA, 'Mia Sample'], [LEO, 'Leo Sample']].map(([child, name]) => ({ studentProfileId: child, displayName: name,
      sessions: sessions.filter(s => s.child === child && Date.parse(s.startsAt) > now().getTime()).map(s => ({
        sessionId: s.sessionId, name: s.name, programName: s.programName, roomName: s.roomName, startsAt: s.startsAt, endsAt: plus(s.startsAt, 45), spotsLeft: s.spotsLeft, booking: booking(s) })) })),
  });
  const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });
  const wrote = <T,>(data: T) => Promise.resolve({ ok: true as const, data, replayed: false });
  const refused = (code: string) => Promise.resolve({ ok: false as const, state: 'refused' as const, code });

  return {
    journey: () => ok(verifyParentJourneyView(journeyRaw())),
    schoolTimeZone: () => Promise.resolve(ZONE),
    classBookings: () => ok(verifyParentClassBookingChoices(choicesRaw())),
    bookClass: (input, _key) => {
      const s = sessions.find(x => x.sessionId === input.sessionId && x.child === input.studentProfileId);
      if (!s) return refused('PARENT_CLASS_BOOKING_NOT_FOUND');
      if (s.bookingId) return refused('PARENT_CLASS_BOOKING_ALREADY_BOOKED');
      if (s.spotsLeft === 0) return refused('PARENT_CLASS_BOOKING_FULL');
      s.bookingId = id(700 + sessions.indexOf(s)); s.spotsLeft--; s.version++;
      return wrote(verifyParentClassBookingReceipt({ booking: booking(s), spotsLeft: s.spotsLeft }, input));
    },
    cancelBooking: (bookingId, _version, _key) => {
      const s = sessions.find(x => x.bookingId === bookingId);
      if (!s) return refused('PARENT_CLASS_BOOKING_NOT_FOUND');
      const receipt = verifyParentClassBookingReceipt({ booking: { ...booking(s)!, status: 'CANCELLED', canCancel: false, version: s.version + 1 }, spotsLeft: s.spotsLeft + 1 }, { bookingId });
      s.bookingId = null; s.spotsLeft++; s.version++;
      return wrote(receipt);
    },
    schoolMessages: () => ok(verifyParentFamilyMessages({ canWrite: true, schoolName: SAMPLE_SCHOOL, threadId: id(800), messages: messages.map(m => ({ ...m })) })),
    sendSchoolMessage: (body, _key) => {
      const message = { messageId: id(1000 + messages.length), from: 'FAMILY' as const, mine: true, body, sentAt: ms(now().toISOString()) };
      messages.push(message);
      return wrote(verifyFamilyMessageReceipt({ threadId: id(800), version: ++messageVersion, message }, { from: 'FAMILY', body }));
    },
    absenceContext: () => ok(verifyParentPlannedAbsenceRequestContext({ children: [{ studentProfileId: MIA, displayName: 'Mia Sample' }, { studentProfileId: LEO, displayName: 'Leo Sample' }] })),
    reportAbsence: (_input, _key) => wrote(verifyParentPlannedAbsenceSubmittedReceipt({ status: 'SUBMITTED', submittedAt: new Date(Math.floor(now().getTime())).toISOString() })),
    billing: () => ok(verifyParentBillingView({
      generatedAt: start.toISOString(), accessLevel: 'PRIMARY_GUARDIAN',
      memberships: { status: 'AVAILABLE', limited: false, items: [
        { participant: { displayName: 'Mia Sample', linkage: 'CURRENT_FAMILY_STUDENT' }, payerLinkage: 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT', state: 'ACTIVE', termStartedAt: at(-60, 0), termEndsAt: at(305, 0) },
        { participant: { displayName: 'Leo Sample', linkage: 'CURRENT_FAMILY_STUDENT' }, payerLinkage: 'CURRENT_FAMILY_DESIGNATED_BILLING_CONTACT', state: 'ACTIVE', termStartedAt: at(-30, 0), termEndsAt: null },
      ] },
      invoices: { status: 'AVAILABLE', limited: false, items: [
        { participant: { displayName: 'Mia Sample', linkage: 'CURRENT_FAMILY_STUDENT' }, status: 'ISSUED', currency: 'USD', totalMinor: 14900, dueAt: at(5, 0), paymentAttempts: { status: 'AVAILABLE', items: [], limited: false } },
        { participant: { displayName: 'Mia Sample', linkage: 'CURRENT_FAMILY_STUDENT' }, status: 'PAID', currency: 'USD', totalMinor: 14900, dueAt: at(-25, 0), paymentAttempts: { status: 'AVAILABLE', items: [], limited: false } },
        { participant: { displayName: 'Leo Sample', linkage: 'CURRENT_FAMILY_STUDENT' }, status: 'PAID', currency: 'USD', totalMinor: 12900, dueAt: at(-25, 0), paymentAttempts: { status: 'AVAILABLE', items: [], limited: false } },
      ] },
    })),
    classPass: () => ok(verifyParentClassPassView({
      generatedAt: start.toISOString(), accessLevel: 'PRIMARY_GUARDIAN', paymentProviderOutcome: 'UNAVAILABLE',
      children: { limited: false, items: [{ displayName: 'Leo Sample', passes: { limited: false, items: [
        { productDisplayName: '10-class pass', remainingUses: 7, expiresAt: at(60, 0), status: 'ACTIVE', bookings: { limited: false, items: [] } },
      ] } }] },
    })),
    testingStatus: () => ok(verifyParentTestingStatusView({
      generatedAt: start.toISOString(), accessLevel: 'PRIMARY_GUARDIAN',
      children: { status: 'AVAILABLE', limited: false, items: [
        { displayName: 'Mia Sample', upcomingEvent: { label: 'Kids belt test', startsAt: at(12, 10), endsAt: at(12, 12) },
          candidates: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Fall belt test', startsAt: at(-40, 10), endsAt: at(-40, 12) }, overallStatus: 'PASSED' }] },
          registrationInterests: { status: 'AVAILABLE', limited: false, items: [{ event: { label: 'Kids belt test', startsAt: at(12, 10), endsAt: at(12, 12) }, status: 'SUBMITTED', submittedAt: at(-2, 9), reviewedAt: null }] },
          certificate: { status: 'ISSUED' } },
        { displayName: 'Leo Sample', upcomingEvent: null,
          candidates: { status: 'AVAILABLE', limited: false, items: [] }, registrationInterests: { status: 'AVAILABLE', limited: false, items: [] }, certificate: { status: 'NOT_ISSUED' } },
      ] },
    })),
    curriculumLibrary: () => ok(verifyParentCurriculumLibrary({ resources: [
      { title: 'Form 1 walkthrough', description: 'Practice the first form at home, step by step.', kind: 'VIDEO', url: 'https://www.myhonos.com/', curriculumName: 'Kids Program', rankName: 'Yellow Belt', childDisplayName: 'Mia Sample' },
      { title: 'Sparring safety basics', description: 'What to bring and how to stay safe.', kind: 'LINK', url: 'https://www.myhonos.com/', curriculumName: 'Junior Program', rankName: null, childDisplayName: 'Leo Sample' },
    ] })),
    // The sample family never reaches HON's AI: Eian stays in guided mode and a question is refused locally.
    eianStatus: () => ok({ mode: 'GUIDED' as const, reason: 'NOT_INCLUDED' as const }),
    askEian: async () => ({ ok: false as const, state: 'refused' as const, code: 'EIAN_AI_UNAVAILABLE' }),
    eianTurn: async () => ({ ok: false as const, state: 'unavailable' as const }),
    // The sample family never pays: no school processor is reachable, so nothing is payable and a press is refused.
    invoicePayments: () => ok(verifyParentInvoicePayments({ canPay: false, testMode: true, invoices: [] })),
    startInvoicePayment: async () => ({ ok: false as const, state: 'refused' as const, code: 'PARENT_INVOICE_PAY_NOT_CONFIGURED' }),
    confirmInvoicePayment: async () => ({ ok: false as const, state: 'refused' as const, code: 'PARENT_INVOICE_PAY_NOT_CONFIGURED' }),
    cancelInvoicePayment: async () => ({ ok: false as const, state: 'refused' as const, code: 'PARENT_INVOICE_PAY_NOT_CONFIGURED' }),
  } as ParentApi;
}
