import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentJourneyView, type ParentJourneyView, type JourneyList, type JourneyAchievement, type JourneyDocument, type DocumentPublicationRecord, type ParentStudentJourney, type ParentStudentJourneyStudent, type ParentFamilySchedule, type AchievementContext } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';
import { ParentStudentJourneyService } from './parent-student-journey.service.js';
import { ParentFamilyScheduleService } from './parent-family-schedule.service.js';
import { AchievementsService } from '../achievements/achievements.service.js';
import { DocumentService } from '../documents/document.service.js';

const unavailable = (reason: 'READ_UNAVAILABLE' | 'READ_API_UNAVAILABLE' | 'CHILD_PROFILE_UNAVAILABLE' | 'CHILD_MATCH_UNAVAILABLE' = 'READ_UNAVAILABLE') => ({ status: 'UNAVAILABLE' as const, reason });
const available = <T>(items: T[], limited = false): JourneyList<T> => ({ status: 'AVAILABLE', items, limited });
function sameScope(a: ResolvedParentFamilyScope, b: ResolvedParentFamilyScope) { return ['principalId', 'organizationId', 'schoolId', 'familyId', 'accessLevel'].every(k => a[k as keyof typeof a] === b[k as keyof typeof b]); }
function childBindings(journey: ParentStudentJourney): string {
  return JSON.stringify(journey.students.map(s => [s.familyMemberId, s.person.id, s.person.givenName, s.person.familyName, s.studentProfile?.id ?? null, s.studentProfile?.status ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
function displayName(s: ParentStudentJourneyStudent) { return `${s.person.givenName} ${s.person.familyName}`.trim(); }
@Injectable()
export class ParentJourneyViewService {
  constructor(private readonly database: RuntimeDatabaseService, private readonly journeys: ParentStudentJourneyService,
    private readonly schedules: ParentFamilyScheduleService, private readonly achievements: AchievementsService, private readonly documents: DocumentService) {}
  private async scope(subject: string): Promise<ResolvedParentFamilyScope> {
    const discovered = await this.database.resolveParentJourneyScopes(subject);
    if (!discovered.length) throw new ForbiddenException({ code: 'PARENT_SCOPE_DENIED', detail: 'Current verified family access is required.' });
    if (discovered.length !== 1) throw new ConflictException({ code: 'PARENT_SCOPE_AMBIGUOUS', detail: 'A verified current-family selector is not available for this account. No family is selected automatically.' });
    const candidate = discovered[0]!;
    const exact = (await this.database.resolveParentFamilyScopes(subject, candidate.schoolId)).find(s => sameScope(s, candidate));
    if (!exact) throw new ForbiddenException({ code: 'PARENT_SCOPE_DENIED' });
    return exact;
  }
  private async optional<T>(read: () => Promise<T>): Promise<T | null> {
    try { return await read(); } catch (e) {
      // Access loss anywhere clears the whole view, never masquerades as empty.
      if (e instanceof HttpException && [401, 403].includes(e.getStatus()) || (e as { code?: string }).code === '42501') throw e;
      return null;
    }
  }
  async get(externalSubject: string) {
    const requestId = randomUUID();
    try {
      const scope = await this.scope(externalSubject);
      const initial = await this.journeys.get(scope, scope.familyId, requestId, externalSubject);
      if (initial.familyId !== scope.familyId || initial.accessLevel !== scope.accessLevel || initial.students.length > 100) throw new Error('Unverified child scope');
      const from = new Date().toISOString(), to = new Date(Date.parse(from) + 30 * 86400000).toISOString();
      const context: AchievementContext = { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId, correlationId: requestId };
      const schedule = await this.optional(() => this.schedules.get(scope, scope.familyId, { from, to }, requestId));
      const awards = new Map<string, JourneyList<JourneyAchievement>>();
      for (const s of initial.students) {
        if (s.studentProfile?.status !== 'ACTIVE') continue;
        const student = s.studentProfile.id;
        const page = await this.optional(() => this.achievements.parent(context, scope.familyId, student));
        if (page && page.studentProfileId !== student) throw new Error('Unverified achievement child');
        awards.set(student, page ? available(page.items.map(a => ({ name: a.definition.name, description: a.definition.description, awardedOn: a.awardedOn })), page.nextAfter !== null) : unavailable());
      }
      // LIST is current family-authorized publications, NOT a receipt list. Do
      // not retrieve evidence by caller IDs or expose body/attestation/actors.
      const docs = await this.optional(() => this.documents.read({ ...context, principalType: 'HUMAN_USER', source: 'HUMAN_UI', audienceMode: 'PARENT', idempotencyKey: '' }, 'LIST', null));
      const documentList: JourneyList<JourneyDocument> = Array.isArray(docs) ? available((docs as DocumentPublicationRecord[]).map(d => {
        if (d.audience !== 'PARENT' || !d.current) throw new Error('Unverified document audience');
        return { title: d.title, publishedAt: d.publishedAt };
      }), docs.length === 50) : unavailable();
      const liveScope = await this.scope(externalSubject);
      if (!sameScope(scope, liveScope)) throw new ForbiddenException({ code: 'PARENT_SCOPE_CHANGED' });
      const current = await this.journeys.get(liveScope, liveScope.familyId, requestId, externalSubject);
      if (current.familyId !== scope.familyId || current.accessLevel !== scope.accessLevel || childBindings(initial) !== childBindings(current)) throw new ForbiddenException({ code: 'CHILD_SCOPE_CHANGED' });
      const view: ParentJourneyView = { generatedAt: new Date().toISOString(), from, to, accessLevel: scope.accessLevel,
        children: current.students.map(s => ({ name: displayName(s), profileAvailable: s.studentProfile?.status === 'ACTIVE',
          programs: s.studentProfile?.status === 'ACTIVE' ? s.curriculumEnrollments.filter(e => e.status === 'ACTIVE').map(e => ({ name: e.curriculum.name, rank: e.currentRank?.name ?? null,
            requirements: e.requirementProgress === undefined ? unavailable('READ_API_UNAVAILABLE') : available(e.requirementProgress.map(r => {
              if (r.enrollmentId !== e.id) throw new Error('Unverified requirement enrollment');
              return { label: r.label, kind: r.kind, required: r.required, status: r.status, recordedAt: r.recordedAt };
            })) })) : [],
          schedule: this.childSchedule(s, current, schedule),
          achievements: s.studentProfile?.status === 'ACTIVE' ? awards.get(s.studentProfile.id) ?? unavailable() : unavailable('CHILD_PROFILE_UNAVAILABLE'),
        })), documents: documentList, documentReceipts: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' }, plannedAbsences: { status: 'UNAVAILABLE', reason: 'READ_API_UNAVAILABLE' } };
      return { data: verifyParentJourneyView(view), meta: { requestId, correlationId: requestId } };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      if ((e as { code?: string }).code === '42501') throw new ForbiddenException({ code: 'PARENT_SCOPE_DENIED' });
      throw new ServiceUnavailableException({ code: 'PARENT_JOURNEY_UNAVAILABLE', detail: 'No verified family result is shown.' });
    }
  }
  private childSchedule(s: ParentStudentJourneyStudent, journey: ParentStudentJourney, schedule: ParentFamilySchedule | null) {
    if (s.studentProfile?.status !== 'ACTIVE') return unavailable('CHILD_PROFILE_UNAVAILABLE');
    if (!schedule) return unavailable();
    const name = displayName(s);
    // Name-only legacy projection cannot disambiguate siblings with equal names.
    if (journey.students.filter(x => displayName(x) === name).length !== 1) return unavailable('CHILD_MATCH_UNAVAILABLE');
    const scheduleName = `${s.person.givenName} ${s.person.familyName}`;
    return available(schedule.bookings.filter(b => b.student.displayName === scheduleName).map(b => ({ name: b.session.name, program: b.program.name, startsAt: b.session.startsAt, endsAt: b.session.endsAt,
      room: b.session.roomName ?? null, bookingStatus: b.booking.status, sessionStatus: b.session.status, kind: b.booking.kind })));
  }
}
