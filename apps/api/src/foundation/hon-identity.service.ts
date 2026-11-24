import { ForbiddenException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, HON_SESSION_COOKIE, bearerToken, cookieValue, sessionConfig, verifyMobileSession, verifySession, verifyStaffMobileSession, type NormalizedIdentity } from '@hon/auth';
import type { Request } from 'express';

export type AuthenticatedIdentity = NormalizedIdentity;
/** WEB = browser cookie session. MOBILE = native app bearer session (family app M2, staff app S0). */
export type HonChannel = 'WEB' | 'MOBILE';
/** Which native app the bearer session belongs to. Unset on the web channel. */
export type HonMobileApp = 'FAMILY' | 'STAFF';
export type HonRequest = Request & { honIdentity?: AuthenticatedIdentity; honChannel?: HonChannel; honMobileApp?: HonMobileApp };

/** HON Family app sessions reach only family-facing routes. */
const FAMILY_MOBILE_ROUTES = /^\/v1\/(?:parent|me|auth\/mobile)\//;
/**
 * HON Staff app sessions reach only this explicit allow-list (S0, docs/architecture/STAFF_MOBILE_SIGN_IN.md). Each
 * later phase adds its exact routes in its own reviewed PR. Everything else (organizations, HQ, parent, other staff
 * routes) stays browser-only. Identity only: every route still authorizes school, role and permission itself.
 */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SCHOOL = `/v1/organizations/${UUID}/schools/${UUID}`;
const SESSION = `${SCHOOL}/schedule/sessions/${UUID}`;
/** One allowed route: an anchored, segment-exact path and, from S1 on, the exact methods. No methods = S0 entry, any method. */
interface StaffMobileRoute { readonly path: RegExp; readonly methods?: readonly string[] }
const STAFF_MOBILE_ROUTES: readonly StaffMobileRoute[] = [
  // S0: sign-in and which school the person works at.
  { path: /^\/v1\/me\/language-preference$/ },
  { path: /^\/v1\/auth\/mobile\/[^/]/ },
  { path: /^\/v1\/staff\/current-reporting-school$/ },
  { path: /^\/v1\/staff\/reporting-schools$/ },
  // S1 Today (docs/architecture/STAFF_MOBILE_TODAY.md): the class list, one class roster, marking attendance, and the
  // person's own time clock. Each route still resolves school and permission itself (schedule.session.read,
  // attendance.record, staff.time.clock).
  { path: new RegExp(`^${SCHOOL}/schedule/sessions/list$`), methods: ['GET'] },
  { path: new RegExp(`^${SESSION}/roster$`), methods: ['GET'] },
  { path: new RegExp(`^${SESSION}/attendance$`), methods: ['GET', 'POST'] },
  { path: new RegExp(`^${SCHOOL}/staff/time/clock$`), methods: ['GET', 'POST'] },
  // Find a student by name to mark one who is not on the roster (walk-in). The controller admits only for=attendance
  // from the app (attendance.record); the other picker purposes stay web-only.
  { path: new RegExp(`^${SCHOOL}/pickers/students$`), methods: ['GET'] },
  // S2 HON tab (docs/architecture/STAFF_MOBILE_HON.md): which agents this person has, their own conversations, one
  // conversation, and sending a turn. Each route resolves school and ai.invocation.plan itself; 0635 refuses a turn or
  // plan for an agent whose switch is off. Tone, briefing, school notes and orchestrations stay web-only.
  { path: new RegExp(`^${SCHOOL}/hon/readiness$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/hon/conversations$`), methods: ['GET', 'POST'] },
  { path: new RegExp(`^${SCHOOL}/hon/conversations/${UUID}$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/hon/conversations/${UUID}/turns$`), methods: ['POST'] },
  // S4 People and Texts (docs/architecture/STAFF_MOBILE_PEOPLE_TEXTS.md): search contacts and read one contact card
  // (people.read, each card section re-checked against its own permission), the texts inbox and one conversation
  // (conversation.read), marking it read (conversation.read) and replying (conversation.manage, the consent-gated
  // queue the web uses). Archive, merge, assign, tag, link and create-lead stay web-only.
  { path: new RegExp(`^${SCHOOL}/contacts$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/contacts/${UUID}$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/conversations$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/conversations/${UUID}$`), methods: ['GET'] },
  { path: new RegExp(`^${SCHOOL}/conversations/${UUID}/read$`), methods: ['POST'] },
  { path: new RegExp(`^${SCHOOL}/conversations/${UUID}/replies$`), methods: ['POST'] },
];
const staffRouteAllowed = (method: string, path: string) =>
  STAFF_MOBILE_ROUTES.some(route => route.path.test(path) && (route.methods === undefined || route.methods.includes(method)));

@Injectable()
export class HonIdentityService {
  authenticate(request: Request): AuthenticatedIdentity {
    let channel: HonChannel;
    let identity: AuthenticatedIdentity;
    let app: HonMobileApp | undefined;
    try {
      const config = sessionConfig();
      const cookie = cookieValue(request.headers.cookie, HON_SESSION_COOKIE);
      if (cookie) {
        // Browser path, unchanged: the cookie decides and any Authorization header (e.g. a staging proxy's Basic
        // auth) is ignored. A browser cannot attach a bearer cross-origin anyway: CORS is off.
        channel = 'WEB';
        const { emailVerified: _proof, ...rest } = verifySession(cookie, config);
        identity = rest;
      } else {
        const bearer = bearerToken(request.headers.authorization);
        if (!bearer) throw new UnauthorizedException('HON requires an authenticated application session.');
        channel = 'MOBILE';
        // Family first, then staff: distinct JWT types and audiences, so a token can only ever match one.
        try { identity = verifyMobileSession(bearer, config); app = 'FAMILY'; }
        catch { identity = verifyStaffMobileSession(bearer, config); app = 'STAFF'; }
      }
    } catch (error) {
      if (error instanceof AuthConfigurationError) throw new ServiceUnavailableException('HON application session validation is not configured.');
      if (error instanceof UnauthorizedException) throw error;
      // Never attach the original JWT/provider error, request, cookie, or authorization header.
      throw new UnauthorizedException('HON could not validate the application session.');
    }
    if (channel === 'MOBILE') {
      const mobileApp: HonMobileApp = app === 'STAFF' ? 'STAFF' : 'FAMILY';
      const path = new URL(request.originalUrl ?? request.url ?? '/', 'http://hon.invalid').pathname;
      const allowed = mobileApp === 'STAFF' ? staffRouteAllowed((request.method ?? '').toUpperCase(), path) : FAMILY_MOBILE_ROUTES.test(path);
      if (!allowed) throw new ForbiddenException({ code: 'MOBILE_SESSION_SCOPE', detail: mobileApp === 'STAFF' ? 'This route is not available to the HON Staff app yet.' : 'This route is not available to the HON Parent app.' });
      (request as HonRequest).honMobileApp = mobileApp;
    }
    (request as HonRequest).honChannel = channel;
    return identity;
  }
}
