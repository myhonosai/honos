import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { communityUuid, communityVersion, validateAchievementDefinition, validateAchievementAward, verifyAchievementDefinition, verifyAchievementAward, verifyAchievementPage, verifyAchievementHistory, verifyAchievementAccess, verifyParentAchievements, type AchievementContext, type AchievementDefinitionInput, type AchievementAwardInput } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
export function achievementId(v: unknown): asserts v is string { try { communityUuid(v); } catch { invalid(); } }
function invalid(): never { throw new BadRequestException({ code: 'VALIDATION_FAILED', detail: 'Closed bounded recognition metadata and explicit human decisions only.' }); }
function human(c: AchievementContext) {
  if (c.principalType !== 'HUMAN_USER' || c.source !== 'HUMAN_UI' || c.actionRequestId || c.delegatedByPrincipalId) throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  for (const id of [c.organizationId, c.schoolId, c.principalId, c.requestId, c.correlationId]) achievementId(id);
  if (typeof c.externalSubject !== 'string' || !c.externalSubject || c.externalSubject.length > 200) invalid();
}
@Injectable()
export class AchievementsService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  private async boundary<T>(c: AchievementContext, sql: string, args: unknown[], verify: (v: unknown) => T): Promise<T> {
    human(c);
    try { return await this.database.withTenantTransaction(c, async client => {
      await client.query("SELECT set_config('app.hon_source',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)", [c.source]);
      await client.query("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'");
      return verify((await client.query<{ data: unknown }>(sql, args)).rows[0]?.data);
    }); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === '42501') throw new ForbiddenException({ code: 'ACHIEVEMENT_FORBIDDEN', detail: 'Current exact school or child authority required.' });
      if (code === 'P0002') throw new NotFoundException({ code: 'ACHIEVEMENT_UNAVAILABLE' });
      if (['40001', '23505', '55P03', '40P01'].includes(code ?? '')) throw new ConflictException({ code: 'ACHIEVEMENT_CONFLICT', detail: 'Reload current versions. Keep the key only for the exact unchanged uncertain request.' });
      if (['22023', '22P02', '22007', '22008', '23514', '23503', '22003'].includes(code ?? '')) invalid();
      throw new ServiceUnavailableException({ code: 'ACHIEVEMENT_UNAVAILABLE', detail: 'No verified result; no save assumed.' });
    }
  }
  private read<T>(c: AchievementContext, mode: string, student: string | null, id: string | null, after: string | null, before: number | null, verify: (v: unknown) => T) {
    for (const x of [student, id, after]) if (x !== null) achievementId(x);
    if (before !== null) { try { communityVersion(before, 1); } catch { invalid(); } }
    return this.boundary(c, 'SELECT hon.read_achievements($1,$2,$3::uuid,$4::uuid,$5::uuid,$6::integer) data', [c.externalSubject, mode, student, id, after, before], verify);
  }
  access(c: AchievementContext) { return this.read(c, 'ACCESS', null, null, null, null, verifyAchievementAccess); }
  definitions(c: AchievementContext, after: string | null = null) {
    return this.read(c, 'DEFINITIONS', null, null, after, null, v => {
      const p = verifyAchievementPage(v, verifyAchievementDefinition); if (after && p.items.some(x => x.id <= after)) throw new Error('Invalid page scope'); return p;
    });
  }
  awards(c: AchievementContext, student: string, after: string | null = null) {
    return this.read(c, 'AWARDS', student, null, after, null, v => {
      const p = verifyAchievementPage(v, verifyAchievementAward); if (p.items.some(x => x.studentProfileId !== student || (after !== null && x.id <= after))) throw new Error('Invalid student scope'); return p;
    });
  }
  history(c: AchievementContext, kind: 'DEFINITION' | 'AWARD', id: string, student: string | null = null, before: number | null = null) {
    if (!['DEFINITION', 'AWARD'].includes(kind) || (kind === 'AWARD') !== (student !== null)) invalid();
    return this.read(c, `${kind}_HISTORY`, student, id, null, before, v => {
      const h = kind === 'DEFINITION' ? verifyAchievementHistory(v, verifyAchievementDefinition) : verifyAchievementHistory(v, verifyAchievementAward);
      if (h.id !== id || h.items.some(x => (before !== null && x.version >= before) || ('studentProfileId' in x && x.studentProfileId !== student))) throw new Error('Invalid history scope'); return h;
    });
  }
  private async mutate<T>(c: AchievementContext, op: string, student: string | null, id: string | null, input: AchievementDefinitionInput | AchievementAwardInput, verify: (v: unknown) => T) {
    human(c); if (id !== null) achievementId(id); if (student !== null) achievementId(student);
    try { if (op === 'DEFINITION') validateAchievementDefinition(input); else validateAchievementAward(input); if ((id === null) !== (input.expectedVersion === 0)) invalid(); } catch { invalid(); }
    const key = c.idempotencyKey;
    if (typeof key !== 'string' || !key || key.length > 200 || key.trim() !== key || /[\u0000-\u001f\u007f]/.test(key)) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return this.boundary(c, 'SELECT hon.mutate_achievements($1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7::uuid,$8::uuid) data', [c.externalSubject, op, student, id, JSON.stringify(input), key, c.requestId, c.correlationId], v => {
      if (!v || typeof v !== 'object' || Object.keys(v).length !== 2 || !Object.hasOwn(v, 'result') || typeof (v as { replayed?: unknown }).replayed !== 'boolean') throw new Error('Unverified receipt');
      const r = v as { result: unknown; replayed: boolean }; const result = verify(r.result);
      const fields = { ...(result as Record<string, unknown>) }; delete fields.id; delete fields.version; delete fields.definition; delete fields.studentProfileId; delete fields.recordedAt; delete fields.awardedByPrincipalId; delete fields.recordedByPrincipalId;
      if ((id !== null && (result as { id: string }).id !== id) || (result as { version: number }).version !== input.expectedVersion + 1
        || Object.entries(fields).some(([k, value]) => JSON.stringify(value) !== JSON.stringify((input as unknown as Record<string, unknown>)[k]))
        || (student !== null && (result as { studentProfileId: string }).studentProfileId !== student)) throw new Error('Unverified decision binding');
      return { result, replayed: r.replayed };
    });
  }
  saveDefinition(c: AchievementContext, id: string | null, input: AchievementDefinitionInput) { return this.mutate(c, 'DEFINITION', null, id, input, verifyAchievementDefinition); }
  saveAward(c: AchievementContext, student: string, id: string | null, input: AchievementAwardInput) { return this.mutate(c, 'AWARD', student, id, input, verifyAchievementAward); }
  parent(c: AchievementContext, family: string, student: string, after: string | null = null) {
    achievementId(family); achievementId(student); if (after !== null) achievementId(after);
    return this.boundary(c, 'SELECT hon.read_parent_achievements($1,$2::uuid,$3::uuid,$4::uuid) data', [c.externalSubject, family, student, after], v => {
      const p = verifyParentAchievements(v, student); if (after && p.items.some(x => x.id <= after)) throw new Error('Invalid child page scope');
      return { studentProfileId: student, ...p };
    });
  }
}
