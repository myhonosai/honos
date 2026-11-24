import { verifyParentJourneyView, type ParentJourneyView } from '@hon/contracts/parent-journey-view';
import {
  verifyParentClassBookingChoices, verifyParentClassBookingReceipt,
  type BookParentClassSessionInput, type ParentClassBookingChoices, type ParentClassBookingReceipt,
} from '@hon/contracts/parent-class-booking';
import { verifyFamilyMessageReceipt, verifyParentFamilyMessages, type FamilyMessageReceipt, type ParentFamilyMessages } from '@hon/contracts/family-messages';
import {
  verifyParentPlannedAbsenceRequestContext, verifyParentPlannedAbsenceSubmittedReceipt,
  type ParentPlannedAbsenceRequestContext, type ParentPlannedAbsenceSubmittedReceipt,
} from '@hon/contracts/parent-planned-absence-request';
import { verifyParentBillingView, type ParentBillingView } from '@hon/contracts/parent-billing-view';
import { verifyParentClassPassView, type ParentClassPassView } from '@hon/contracts/parent-classpass-view';
import { verifyParentTestingStatusView, type ParentTestingStatusView } from '@hon/contracts/parent-testing-status';
import { verifyParentCurriculumLibrary, type ParentCurriculumLibrary } from '@hon/contracts/curriculum-resource-library';
import { verifyParentCurriculumApp, type ParentCurriculumApp } from '@hon/contracts/parent-app-curriculum';
import {
  validateBookParentSchoolBookingTypeInput, validateBookParentSchoolEventSlotInput, validateCancelParentSchoolBookingInput,
  verifyParentSchoolBookingReceipt, verifyParentSchoolBookings,
  type BookParentSchoolBookingTypeInput, type ParentSchoolBookingReceipt, type ParentSchoolBookings,
} from '@hon/contracts/parent-school-bookings';
import { verifyEianStatus, verifyEianTurn, type EianStatus, type EianTurn } from '@hon/contracts/eian';
import { validateEianSpeechInput, verifyEianSpeechClip, verifyEianSpeechStatus, type EianSpeechClip, type EianSpeechStatus } from '@hon/contracts/eian-speech';
import {
  verifyParentInvoicePayResult, verifyParentInvoicePayStart, verifyParentInvoicePayments,
  type ParentInvoicePayResult, type ParentInvoicePayStart, type ParentInvoicePayments,
} from '@hon/contracts/parent-invoice-pay';
import { verifyParentSchoolAnnouncements, type ParentSchoolAnnouncements } from '@hon/contracts/school-announcements';
import { verifyParentAttendanceStreaks, type ParentAttendanceStreaks } from '@hon/contracts/parent-attendance-streaks';
import { verifyParentProShop, type ParentProShop } from '@hon/contracts/parent-pro-shop';
import { verifyParentJourneyRecommendations, verifyParentJourneyResponseReceipt, type ParentJourneyRecommendations, type ParentJourneyResponseInput,
  type ParentJourneyResponseReceipt } from '@hon/contracts/journey-recommendations';
import { verifyParentReferralLink, verifyParentReferrals, type ParentReferralLink, type ParentReferrals } from '@hon/contracts/family-referrals';
import {
  validateRegisterParentPushDeviceInput, validateUnregisterParentPushDeviceInput, verifyParentPushDeviceReceipt, verifyParentPushStatus, verifyParentPushUnregisterReceipt,
  type ParentPushDeviceReceipt, type ParentPushPlatform, type ParentPushStatus, type ParentPushUnregisterReceipt,
} from '@hon/contracts/parent-push';
import {
  validateOpenParentCheckoutOrderInput, verifyParentCheckoutOrderResult, verifyParentCheckoutOrderStart, verifyParentCheckoutPages,
  type OpenParentCheckoutOrderInput, type ParentCheckoutOrderResult, type ParentCheckoutOrderStart, type ParentCheckoutPages,
} from '@hon/contracts/family-checkout';

/**
 * What a screen shows when a read does not return verified data. Every protected read maps to one of these;
 * there is no state in which unverified or stale data is presented as current.
 */
export type ParentFailureState = 'signed-out' | 'access-denied' | 'choose-family' | 'unavailable' | 'offline';
export type ParentRead<T> = { ok: true; data: T } | { ok: false; state: ParentFailureState };

/**
 * A command's outcome. `unknown` means the request may or may not have reached HON (network failure, timeout,
 * unreadable answer): the caller must re-read before offering a retry, and a retry reuses the same Idempotency-Key.
 * `refused` is a definite no from HON (full, already booked, changed, ...) with HON's code.
 */
export type ParentWrite<T> = { ok: true; data: T; replayed: boolean }
  | { ok: false; state: ParentFailureState | 'unknown' | 'refused'; code?: string };

export interface PlannedAbsenceInput { studentProfileId: string; startsAt: string; endsAt: string; reason?: string }

export interface ParentApiOptions {
  baseUrl: string;
  /** Returns the signed HON mobile session, or null when signed out. Never a family, school or child id. */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ACCESS_DENIED = new Set(['PARENT_SCOPE_DENIED', 'PARENT_SCOPE_CHANGED', 'CHILD_SCOPE_CHANGED']);

export function classifyFailure(status: number, code: unknown): ParentFailureState {
  if (status === 401) return 'signed-out';
  if (status === 403 && typeof code === 'string' && ACCESS_DENIED.has(code)) return 'access-denied';
  if (status === 409 && code === 'PARENT_SCOPE_AMBIGUOUS') return 'choose-family';
  return 'unavailable';
}

/** The API base exactly as reads use it (origin + path, e.g. https://app.myhonos.com/api). Sign-in must use the same base. */
export function checkedBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('The HON API address is not a valid URL.'); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '10.0.2.2';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The HON API address must use https.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The HON API address must be a plain origin.');
  if (/REPLACE-WITH/i.test(raw)) throw new Error('The HON API address has not been configured for this build.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function validTimeZone(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; } catch { return null; }
}

/** Unwraps HON's `{ data, meta }` envelope before the shared contract verifier runs. */
function dataOf<T>(verify: (data: unknown) => T): (body: unknown) => T {
  return body => verify((body as { data?: unknown } | null)?.data);
}

export function createParentApi(options: ParentApiOptions) {
  const baseUrl = checkedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function get<T>(path: string, verify: (body: unknown) => T): Promise<ParentRead<T>> {
    const token = await options.getToken();
    if (!token) return { ok: false, state: 'signed-out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'GET', credentials: 'omit', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
    } catch {
      return { ok: false, state: 'offline' };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* an unreadable body is handled below */ }
    if (!response.ok) return { ok: false, state: classifyFailure(response.status, (body as { code?: unknown } | null)?.code) };
    try { return { ok: true, data: verify(body) }; } catch { return { ok: false, state: 'unavailable' }; }
  }

  /** `definite` lists 5xx codes that are a definite no (nothing was asked), not an unknown outcome. */
  async function post<T>(path: string, command: string, idempotencyKey: string, payload: unknown, verify: (body: unknown) => T,
    definite: readonly string[] = []): Promise<ParentWrite<T>> {
    if (!/^[A-Za-z0-9-]{16,200}$/.test(idempotencyKey)) throw new Error('A command needs a fresh Idempotency-Key.');
    const token = await options.getToken();
    if (!token) return { ok: false, state: 'signed-out' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      // Native request: no Origin and no cookie. The server's native rule admits exactly this shape.
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST', credentials: 'omit', signal: controller.signal, body: JSON.stringify(payload),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          'x-hon-human-command': command, 'Idempotency-Key': idempotencyKey },
      });
    } catch {
      return { ok: false, state: 'unknown' };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown = null;
    try { body = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
      const code = (body as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && definite.includes(code)) return { ok: false, state: 'refused', code };
      if (response.status >= 500 || code === 'IDEMPOTENCY_IN_PROGRESS') return { ok: false, state: 'unknown' };
      const state = classifyFailure(response.status, code);
      if (state !== 'unavailable') return { ok: false, state };
      return { ok: false, state: 'refused', ...(typeof code === 'string' ? { code } : {}) };
    }
    try {
      const envelope = body as { data?: unknown; meta?: { replayed?: unknown } } | null;
      return { ok: true, data: verify(envelope?.data), replayed: envelope?.meta?.replayed === true };
    } catch { return { ok: false, state: 'unknown' }; }
  }

  return {
    /** True only for the made-up sample family: screens never open real outside pages for it. */
    sampleMode: false as boolean,
    journey: (): Promise<ParentRead<ParentJourneyView>> => get('/v1/parent/journey', verifyParentJourneyView),
    /** The school's IANA time zone from the class booking read; null when that read is not available. */
    async schoolTimeZone(): Promise<string | null> {
      const read = await get('/v1/parent/class-bookings', body => {
        const zone = validTimeZone((body as { data?: { timezone?: unknown } } | null)?.data?.timezone);
        if (!zone) throw new Error('no time zone');
        return zone;
      });
      return read.ok ? read.data : null;
    },
    classBookings: (): Promise<ParentRead<ParentClassBookingChoices>> =>
      get('/v1/parent/class-bookings', body => verifyParentClassBookingChoices((body as { data?: unknown } | null)?.data)),
    bookClass: (input: BookParentClassSessionInput, idempotencyKey: string): Promise<ParentWrite<ParentClassBookingReceipt>> =>
      post('/v1/parent/class-bookings', 'parent.class_booking.book', idempotencyKey,
        { studentProfileId: input.studentProfileId, sessionId: input.sessionId }, data => verifyParentClassBookingReceipt(data, input)),
    cancelBooking: (bookingId: string, expectedVersion: number, idempotencyKey: string): Promise<ParentWrite<ParentClassBookingReceipt>> =>
      post(`/v1/parent/class-bookings/${encodeURIComponent(bookingId)}/cancel`, 'parent.class_booking.cancel', idempotencyKey,
        { expectedVersion }, data => verifyParentClassBookingReceipt(data, { bookingId })),
    /** The family's one conversation with its school (0330). No family, school or thread id is ever sent. */
    schoolMessages: (): Promise<ParentRead<ParentFamilyMessages>> =>
      get('/v1/parent/messages/school', body => verifyParentFamilyMessages((body as { data?: unknown } | null)?.data)),
    sendSchoolMessage: (body: string, idempotencyKey: string): Promise<ParentWrite<FamilyMessageReceipt>> =>
      post('/v1/parent/messages/school', 'parent.family_messages.send', idempotencyKey, { body },
        data => verifyFamilyMessageReceipt(data, { from: 'FAMILY', body })),
    /** Children this parent may report a planned absence for; the server re-checks the child on submit. */
    absenceContext: (): Promise<ParentRead<ParentPlannedAbsenceRequestContext>> =>
      get('/v1/parent/planned-absences/context', body => verifyParentPlannedAbsenceRequestContext((body as { data?: unknown } | null)?.data)),
    reportAbsence: (input: PlannedAbsenceInput, idempotencyKey: string): Promise<ParentWrite<ParentPlannedAbsenceSubmittedReceipt>> =>
      post('/v1/parent/planned-absences', 'parent-planned-absence', idempotencyKey,
        { studentProfileId: input.studentProfileId, startsAt: input.startsAt, endsAt: input.endsAt, ...(input.reason ? { reason: input.reason } : {}) },
        verifyParentPlannedAbsenceSubmittedReceipt),
    /** Read-only, redacted family billing: memberships and invoices. Paying an invoice is the separate path below. */
    billing: (): Promise<ParentRead<ParentBillingView>> => get('/v1/parent/billing', dataOf(verifyParentBillingView)),
    /** 0530: the family's open invoices the parent may pay on the school's own processor page (test mode only). */
    /** The school's live announcements (0576) for the one family this sign-in belongs to. No school or family id is sent. */
    announcements: (): Promise<ParentRead<ParentSchoolAnnouncements>> => get('/v1/parent/announcements', dataOf(verifyParentSchoolAnnouncements)),
    /** Each child's weekly attendance streak (0602) for the one family this sign-in belongs to: name and number only. */
    attendanceStreaks: (): Promise<ParentRead<ParentAttendanceStreaks>> => get('/v1/parent/attendance-streaks', dataOf(verifyParentAttendanceStreaks)),
    /** 0603: what the school recommends for each child at the point they have reached on their journey. Read only. */
    journeyRecommendations: (): Promise<ParentRead<ParentJourneyRecommendations>> => get('/v1/parent/journey-recommendations', dataOf(verifyParentJourneyRecommendations)),
    /**
     * 0608 (guardians): "Not now" (HIDDEN, the family stops seeing it) or interest for a named child or a brother or sister
     * (INTERESTED: the school sees it and gets a lead to follow up). Nothing is sent, bought or booked.
     */
    respondJourneyRecommendation: (recommendationId: string, input: ParentJourneyResponseInput, idempotencyKey: string): Promise<ParentWrite<ParentJourneyResponseReceipt>> =>
      post(`/v1/parent/journey-recommendations/${encodeURIComponent(recommendationId)}/response`, 'parent.journey_recommendations.respond', idempotencyKey, input,
        data => verifyParentJourneyResponseReceipt(data, { recommendationId, ...input })),
    /** 0601: whether the school's server sends notifications at all (the app asks for permission only then). */
    pushStatus: (): Promise<ParentRead<ParentPushStatus>> => get('/v1/parent/push-devices/status', dataOf(verifyParentPushStatus)),
    /** 0601: this phone's Expo push token for announcement notifications. The server decides the person and school. */
    registerPushDevice: (expoPushToken: string, platform: ParentPushPlatform, idempotencyKey: string): Promise<ParentWrite<ParentPushDeviceReceipt>> =>
      post('/v1/parent/push-devices', 'parent.push_device.register', idempotencyKey, validateRegisterParentPushDeviceInput({ expoPushToken, platform }),
        data => verifyParentPushDeviceReceipt(data, platform)),
    /** 0601: stop notifications to this phone (sign out). */
    unregisterPushDevice: (expoPushToken: string, idempotencyKey: string): Promise<ParentWrite<ParentPushUnregisterReceipt>> =>
      post('/v1/parent/push-devices/unregister', 'parent.push_device.unregister', idempotencyKey, validateUnregisterParentPushDeviceInput({ expoPushToken }),
        verifyParentPushUnregisterReceipt),
    /** The school's own Shopify products (0581); buying opens the school's store page. No school or family id is sent. */
    proShop: (): Promise<ParentRead<ParentProShop>> => get('/v1/parent/pro-shop', dataOf(verifyParentProShop)),
    /** 0604: the school's family referral program, the family's counts and referrals (never a friend's name). */
    referrals: (): Promise<ParentRead<ParentReferrals>> => get('/v1/parent/referrals', dataOf(verifyParentReferrals)),
    /** 0604: the family's personal link, created once per school; the same link every time. Needs a guardian. */
    referralLink: (idempotencyKey: string): Promise<ParentWrite<ParentReferralLink>> =>
      post('/v1/parent/referrals/link', 'parent.referrals.link', idempotencyKey, {}, verifyParentReferralLink, ['PARENT_REFERRALS_NOT_CONFIGURED']),
    /** 0598: the school's checkout pages the family can buy from, the family's children and latest orders. No school or family id is sent. */
    checkoutPages: (): Promise<ParentRead<ParentCheckoutPages>> => get('/v1/parent/checkout-pages', dataOf(verifyParentCheckoutPages)),
    /** Places an order and opens the processor page when it is not free. The server decides who, what and how much. */
    orderCheckout: (input: OpenParentCheckoutOrderInput, idempotencyKey: string): Promise<ParentWrite<ParentCheckoutOrderStart>> =>
      post('/v1/parent/checkout-pages/orders', 'parent.checkout.order', idempotencyKey, validateOpenParentCheckoutOrderInput(input), verifyParentCheckoutOrderStart,
        // The return page is checked before anything is written, so this 503 is a definite no.
        ['FAMILY_CHECKOUT_NOT_CONFIGURED']),
    startCheckoutOrder: (orderId: string, idempotencyKey: string): Promise<ParentWrite<ParentCheckoutOrderStart>> =>
      post(`/v1/parent/checkout-pages/orders/${encodeURIComponent(orderId)}/start`, 'parent.checkout.pay.start', idempotencyKey, {}, verifyParentCheckoutOrderStart,
        ['FAMILY_CHECKOUT_NOT_CONFIGURED']),
    /** The processor's own answer for the order's payment, as HON recorded it. */
    confirmCheckoutOrder: (orderId: string, idempotencyKey: string): Promise<ParentWrite<ParentCheckoutOrderResult>> =>
      post(`/v1/parent/checkout-pages/orders/${encodeURIComponent(orderId)}/confirm`, 'parent.checkout.pay.confirm', idempotencyKey, {}, verifyParentCheckoutOrderResult),
    cancelCheckoutOrder: (orderId: string, idempotencyKey: string): Promise<ParentWrite<ParentCheckoutOrderResult>> =>
      post(`/v1/parent/checkout-pages/orders/${encodeURIComponent(orderId)}/cancel`, 'parent.checkout.pay.cancel', idempotencyKey, {}, verifyParentCheckoutOrderResult),
    invoicePayments: (): Promise<ParentRead<ParentInvoicePayments>> => get('/v1/parent/invoice-payments', dataOf(verifyParentInvoicePayments)),
    /** Opens (or gets back) the processor page for one invoice. The server decides the amount; the app sends nothing else. */
    startInvoicePayment: (invoiceId: string, idempotencyKey: string): Promise<ParentWrite<ParentInvoicePayStart>> =>
      post(`/v1/parent/invoice-payments/${encodeURIComponent(invoiceId)}/start`, 'parent.invoice.pay.start', idempotencyKey, {}, verifyParentInvoicePayStart,
        // The return page is checked before anything is opened, so this 503 is a definite no.
        ['PARENT_INVOICE_PAY_NOT_CONFIGURED']),
    /** The processor's own answer for the invoice's payment, as HON recorded it. */
    confirmInvoicePayment: (invoiceId: string, idempotencyKey: string): Promise<ParentWrite<ParentInvoicePayResult>> =>
      post(`/v1/parent/invoice-payments/${encodeURIComponent(invoiceId)}/confirm`, 'parent.invoice.pay.confirm', idempotencyKey, {}, verifyParentInvoicePayResult),
    cancelInvoicePayment: (invoiceId: string, idempotencyKey: string): Promise<ParentWrite<ParentInvoicePayResult>> =>
      post(`/v1/parent/invoice-payments/${encodeURIComponent(invoiceId)}/cancel`, 'parent.invoice.pay.cancel', idempotencyKey, {}, verifyParentInvoicePayResult),
    /** 0466: school events with open times and families-only booking types; the family's own bookings made here. */
    schoolBookings: (): Promise<ParentRead<ParentSchoolBookings>> => get('/v1/parent/school-bookings', dataOf(verifyParentSchoolBookings)),
    bookSchoolEventSlot: (slotId: string, idempotencyKey: string): Promise<ParentWrite<ParentSchoolBookingReceipt>> =>
      post('/v1/parent/school-bookings/event-slots', 'parent.school_booking.book', idempotencyKey, validateBookParentSchoolEventSlotInput({ slotId }),
        data => verifyParentSchoolBookingReceipt(data, { kind: 'EVENT' })),
    bookSchoolBookingType: (input: BookParentSchoolBookingTypeInput, idempotencyKey: string): Promise<ParentWrite<ParentSchoolBookingReceipt>> =>
      post('/v1/parent/school-bookings/booking-types', 'parent.school_booking.book', idempotencyKey, validateBookParentSchoolBookingTypeInput(input),
        data => verifyParentSchoolBookingReceipt(data, { kind: 'BOOKING_TYPE' })),
    cancelSchoolBooking: (bookingId: string, expectedVersion: number, idempotencyKey: string): Promise<ParentWrite<ParentSchoolBookingReceipt>> => {
      const input = validateCancelParentSchoolBookingInput({ bookingId, expectedVersion });
      return post(`/v1/parent/school-bookings/${encodeURIComponent(input.bookingId)}/cancel`, 'parent.school_booking.cancel', idempotencyKey,
        { expectedVersion: input.expectedVersion }, data => verifyParentSchoolBookingReceipt(data, { bookingId: input.bookingId }));
    },
    classPass: (): Promise<ParentRead<ParentClassPassView>> => get('/v1/parent/classpass', dataOf(verifyParentClassPassView)),
    testingStatus: (): Promise<ParentRead<ParentTestingStatusView>> => get('/v1/parent/testing/status', dataOf(verifyParentTestingStatusView)),
    curriculumLibrary: (): Promise<ParentRead<ParentCurriculumLibrary>> => get('/v1/parent/curriculum-library', dataOf(verifyParentCurriculumLibrary)),
    /** The Curriculum screen (0610): per child, the current rank or cycle and the material the school shares for it. No ids. */
    curriculumApp: (): Promise<ParentRead<ParentCurriculumApp>> => get('/v1/parent/curriculum-app', dataOf(verifyParentCurriculumApp)),
    /** Whether Eian answers with the school's AI right now (AI) or only with guided answers (GUIDED), with a closed reason. */
    eianStatus: (): Promise<ParentRead<EianStatus>> => get('/v1/parent/eian/status', dataOf(verifyEianStatus)),
    /**
     * One question to Eian AI. One key per question: after an unknown outcome the caller re-asks with the SAME key and the
     * exact same question, and HON replays that turn instead of asking again. The answer is text only; nothing it says runs.
     */
    askEian: (question: string, idempotencyKey: string): Promise<ParentWrite<EianTurn>> => {
      const asked = question.trim();
      return post('/v1/parent/eian/turns', 'parent.eian.ask', idempotencyKey, { question: asked }, data => {
        const turn = verifyEianTurn(data);
        if (turn.question !== asked) throw new Error('Eian answered a different question.');
        return turn;
      }, ['EIAN_AI_UNAVAILABLE']);
    },
    /** Whether Eian's answers are read by the natural voice (NATURAL) or by the phone's own voice (PHONE), with a closed reason. */
    eianSpeechStatus: (): Promise<ParentRead<EianSpeechStatus>> => get('/v1/parent/eian/speech/status', dataOf(verifyEianSpeechStatus)),
    /**
     * One clip of Eian's natural voice for the exact words the phone's own voice would read. One fresh key per answer and
     * never a retry: the sound is not kept by HON, so a lost or refused clip is read by the phone's own voice instead.
     */
    eianSpeak: (text: string, idempotencyKey: string): Promise<ParentWrite<EianSpeechClip>> =>
      post('/v1/parent/eian/speech', 'parent.eian.speak', idempotencyKey, validateEianSpeechInput({ text }), verifyEianSpeechClip,
        ['EIAN_SPEECH_UNAVAILABLE', 'EIAN_SPEECH_OUTCOME_UNKNOWN']),
    eianTurn: (turnId: string): Promise<ParentRead<EianTurn>> =>
      get(`/v1/parent/eian/turns/${encodeURIComponent(turnId)}`, body => {
        const turn = verifyEianTurn((body as { data?: unknown } | null)?.data);
        if (turn.id !== turnId) throw new Error('Eian returned a different turn.');
        return turn;
      }),
  };
}
export type ParentApi = ReturnType<typeof createParentApi>;
