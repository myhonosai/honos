import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AchievementContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { AchievementsService, achievementId } from './achievements.service.js';
import { AchievementDefinitionDto, AchievementAwardDto, AchievementHumanUiGuard } from './achievements.dto.js';
function query(q: Record<string, unknown>, allowed: string[]) {
  if (!q || Object.keys(q).some(k => !['schoolId', ...allowed].includes(k))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  achievementId(q.schoolId);
}
function after(q: Record<string, unknown>) { if (q.after !== undefined) achievementId(q.after); return q.after as string | undefined ?? null; }
function before(q: Record<string, unknown>) {
  if (q.before !== undefined && (typeof q.before !== 'string' || !/^[1-9][0-9]{0,8}$/.test(q.before))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  return q.before === undefined ? null : Number(q.before);
}
@Controller('staff/students/achievements')
@UseGuards(HonIdentityGuard, AchievementHumanUiGuard)
export class AchievementsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly achievements: AchievementsService) {}
  private async context(req: HonRequest, q: Record<string, unknown>, allowed: string[], key = ''): Promise<AchievementContext> {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' }); query(q, allowed);
    const externalSubject = req.honIdentity.externalSubject; const scope = await this.database.resolveAchievementScope(externalSubject, q.schoolId as string);
    if (!scope) throw new ForbiddenException({ code: 'ACHIEVEMENT_SCOPE_DENIED' });
    const id = randomUUID(); return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(c: AchievementContext, data: T, replayed = false) { return { data, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Get('access')
  async access(@Query() q: Record<string, unknown>, @Req() req: HonRequest) { const c = await this.context(req, q, []); return this.envelope(c, await this.achievements.access(c)); }
  @Header('Cache-Control', 'private, no-store') @Get('definitions')
  async definitions(@Query() q: Record<string, unknown>, @Req() req: HonRequest) { const c = await this.context(req, q, ['after']); return this.envelope(c, await this.achievements.definitions(c, after(q))); }
  @Header('Cache-Control', 'private, no-store') @Get('definitions/:id/history')
  async definitionHistory(@Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) { achievementId(id); const c = await this.context(req, q, ['before']); return this.envelope(c, await this.achievements.history(c, 'DEFINITION', id, null, before(q))); }
  @Header('Cache-Control', 'private, no-store') @Post('definitions') @HttpCode(200)
  async createDefinition(@Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() input: AchievementDefinitionDto, @Req() req: HonRequest) { const c = await this.context(req, q, [], key); const r = await this.achievements.saveDefinition(c, null, input); return this.envelope(c, r.result, r.replayed); }
  @Header('Cache-Control', 'private, no-store') @Post('definitions/:id/revisions') @HttpCode(200)
  async reviseDefinition(@Param('id') id: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() input: AchievementDefinitionDto, @Req() req: HonRequest) { achievementId(id); const c = await this.context(req, q, [], key); const r = await this.achievements.saveDefinition(c, id, input); return this.envelope(c, r.result, r.replayed); }
  @Header('Cache-Control', 'private, no-store') @Get('students/:student/awards')
  async awards(@Param('student') student: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) { achievementId(student); const c = await this.context(req, q, ['after']); return this.envelope(c, await this.achievements.awards(c, student, after(q))); }
  @Header('Cache-Control', 'private, no-store') @Get('students/:student/awards/:id/history')
  async awardHistory(@Param('student') student: string, @Param('id') id: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) { achievementId(student); achievementId(id); const c = await this.context(req, q, ['before']); return this.envelope(c, await this.achievements.history(c, 'AWARD', id, student, before(q))); }
  @Header('Cache-Control', 'private, no-store') @Post('students/:student/awards') @HttpCode(200)
  async createAward(@Param('student') student: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() input: AchievementAwardDto, @Req() req: HonRequest) { achievementId(student); const c = await this.context(req, q, [], key); const r = await this.achievements.saveAward(c, student, null, input); return this.envelope(c, r.result, r.replayed); }
  @Header('Cache-Control', 'private, no-store') @Post('students/:student/awards/:id/revisions') @HttpCode(200)
  async reviseAward(@Param('student') student: string, @Param('id') id: string, @Query() q: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() input: AchievementAwardDto, @Req() req: HonRequest) { achievementId(student); achievementId(id); const c = await this.context(req, q, [], key); const r = await this.achievements.saveAward(c, student, id, input); return this.envelope(c, r.result, r.replayed); }
}
@Controller('parent/students/:student/achievements')
@UseGuards(HonIdentityGuard)
export class ParentAchievementsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly achievements: AchievementsService) {}
  @Header('Cache-Control', 'private, no-store') @Get()
  async read(@Param('student') student: string, @Query() q: Record<string, unknown>, @Req() req: HonRequest) {
    if (!req.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    query(q, ['familyId', 'after']); achievementId(q.familyId); achievementId(student);
    const externalSubject = req.honIdentity.externalSubject;
    const scope = (await this.database.resolveParentFamilyScopes(externalSubject, q.schoolId as string)).find(s => s.familyId === q.familyId);
    if (!scope) throw new ForbiddenException({ code: 'CHILD_SCOPE_DENIED' });
    const id = randomUUID(); const c: AchievementContext = { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id };
    return { data: await this.achievements.parent(c, scope.familyId, student, after(q)), meta: { requestId: id, correlationId: id } };
  }
}
