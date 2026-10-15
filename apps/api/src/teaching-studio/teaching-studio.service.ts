import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { communityUuid, communityVersion, validateTeachingAssessment, validateTeachingLesson, validateTeachingResource, verifyTeachingAccess, verifyTeachingAssessment, verifyTeachingHistory, verifyTeachingLesson, verifyTeachingPage, verifyTeachingResource, type TeachingAssessment, type TeachingAssessmentInput, type TeachingLesson, type TeachingLessonInput, type TeachingResource, type TeachingResourceInput, type TeachingStudioContext } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

export function teachingId(value: unknown): asserts value is string { try { communityUuid(value); } catch { invalid(); } }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Use the closed bounded Teaching Studio contract, known school/student references, and a current version.' }); }
function human(context: TeachingStudioContext) {
  if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [context.organizationId, context.schoolId, context.principalId, context.requestId, context.correlationId]) teachingId(id);
  if (typeof context.externalSubject !== 'string' || !context.externalSubject || context.externalSubject.length > 200) invalid();
}
function boundaryError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '42501') throw new ForbiddenException({ code: 'TEACHING_STUDIO_FORBIDDEN', detail: 'Current direct human staff permission, active entitlement, and exact school are required.' });
  if (code === 'P0002') throw new NotFoundException({ code: 'TEACHING_STUDIO_UNAVAILABLE' });
  if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'TEACHING_STUDIO_CONFLICT', detail: 'Refresh the current record. Retry only the exact unchanged uncertain request with its retained key.' });
  if (code === '57014') throw new ServiceUnavailableException({ code: 'TEACHING_STUDIO_UNAVAILABLE', detail: 'No verified save is assumed. Refresh or retry unchanged with the retained key.' });
  if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalid();
  throw new ServiceUnavailableException({ code: 'TEACHING_STUDIO_UNAVAILABLE', detail: 'No verified result is available.' });
}
@Injectable()
export class TeachingStudioService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(context: TeachingStudioContext, sql: string, args: unknown[], verify: (value: unknown) => T): Promise<T> {
    human(context);
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [context.source]);
        await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
        return verify((await client.query<{ data: unknown }>(sql, args)).rows[0]?.data);
      });
    } catch (error) { return boundaryError(error); }
  }
  private read<T>(context: TeachingStudioContext, mode: string, student: string | null, id: string | null, before: number | null, verify: (value: unknown) => T) {
    if (student !== null) teachingId(student); if (id !== null) teachingId(id); if (before !== null) { try { communityVersion(before, 1); } catch { invalid(); } }
    return this.boundary(context, 'SELECT hon.read_teaching_studio($1,$2,$3::uuid,$4::uuid,$5::integer) data', [context.externalSubject, mode, student, id, before], verify);
  }
  access(context: TeachingStudioContext) { return this.read(context, 'ACCESS', null, null, null, verifyTeachingAccess); }
  lessons(context: TeachingStudioContext) { return this.read(context, 'LESSONS', null, null, null, value => verifyTeachingPage(value, verifyTeachingLesson)); }
  resources(context: TeachingStudioContext) { return this.read(context, 'RESOURCES', null, null, null, value => verifyTeachingPage(value, verifyTeachingResource)); }
  assessments(context: TeachingStudioContext, student: string) { return this.read(context, 'ASSESSMENTS', student, null, null, value => { const page = verifyTeachingPage(value, verifyTeachingAssessment); if (page.items.some(item => item.studentProfileId !== student)) throw new Error('Invalid student scope'); return page; }); }
  history(context: TeachingStudioContext, kind: 'LESSON' | 'RESOURCE' | 'ASSESSMENT', id: string, student: string | null, before: number | null) {
    if ((kind === 'ASSESSMENT') !== (student !== null)) invalid();
    if (kind === 'LESSON') return this.read(context, 'LESSON_HISTORY', null, id, before, value => {
      const history = verifyTeachingHistory(value, verifyTeachingLesson);
      if (history.id !== id || history.items.some(item => before !== null && item.version >= before)) throw new Error('Invalid Teaching Studio lesson history scope');
      return history;
    });
    if (kind === 'RESOURCE') return this.read(context, 'RESOURCE_HISTORY', null, id, before, value => {
      const history = verifyTeachingHistory(value, verifyTeachingResource);
      if (history.id !== id || history.items.some(item => before !== null && item.version >= before)) throw new Error('Invalid Teaching Studio resource history scope');
      return history;
    });
    return this.read(context, 'ASSESSMENT_HISTORY', student, id, before, value => {
      const history = verifyTeachingHistory(value, verifyTeachingAssessment);
      if (history.id !== id || history.items.some(item => (before !== null && item.version >= before) || item.studentProfileId !== student)) throw new Error('Invalid Teaching Studio assessment history scope');
      return history;
    });
  }
  private async mutate<T extends TeachingLesson | TeachingResource | TeachingAssessment>(context: TeachingStudioContext, op: 'LESSON' | 'RESOURCE' | 'ASSESSMENT', student: string | null, id: string | null, input: TeachingLessonInput | TeachingResourceInput | TeachingAssessmentInput, verify: (value: unknown) => T) {
    human(context); if (student !== null) teachingId(student); if (id !== null) teachingId(id);
    try {
      if (op === 'LESSON') validateTeachingLesson(input); else if (op === 'RESOURCE') validateTeachingResource(input); else validateTeachingAssessment(input);
      if ((id === null) !== (input.expectedVersion === 0)) invalid();
    } catch { invalid(); }
    const key = context.idempotencyKey;
    if (typeof key !== 'string' || !key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(context, 'SELECT hon.mutate_teaching_studio($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data', [context.externalSubject, op, student, id, JSON.stringify(input), key, context.requestId, context.correlationId], value => {
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'result') || typeof (value as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified Teaching Studio receipt');
      const receipt = value as { result: unknown; replayed: boolean }; const result = verify(receipt.result);
      if (result.version !== input.expectedVersion + 1 || (id !== null && result.id !== id) || (op === 'ASSESSMENT' && (result as TeachingAssessment).studentProfileId !== student)) throw new Error('Unverified Teaching Studio receipt binding');
      return { result, replayed: receipt.replayed };
    });
  }
  saveLesson(context: TeachingStudioContext, id: string | null, input: TeachingLessonInput) { return this.mutate(context, 'LESSON', null, id, input, verifyTeachingLesson); }
  saveResource(context: TeachingStudioContext, id: string | null, input: TeachingResourceInput) { return this.mutate(context, 'RESOURCE', null, id, input, verifyTeachingResource); }
  saveAssessment(context: TeachingStudioContext, student: string, id: string | null, input: TeachingAssessmentInput) { return this.mutate(context, 'ASSESSMENT', student, id, input, verifyTeachingAssessment); }
}
