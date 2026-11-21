import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Req, UseGuards, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Allow } from 'class-validator';
import { RANK_SETUP_COMMAND, type CurriculumResourceContext, type RankSetupOperation } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumHumanUiGuard } from './curriculum-human-ui.guard.js';
import { RankSetupService } from './rank-setup.service.js';

/** Same rules as the parent app curriculum guard (no selectors, no X-Hon-* but the command, same-origin POST), with its own command. */
@Injectable()
export class RankSetupHumanUiGuard extends CurriculumHumanUiGuard {
 protected readonly command: string = RANK_SETUP_COMMAND;
 canActivate(context: ExecutionContext): boolean {
  const r = context.switchToHttp().getRequest<Request>();
  if (r.originalUrl?.includes('?') || Object.keys(r.query ?? {}).length) throw new BadRequestException({ code: 'RANK_SETUP_SELECTORS_NOT_ACCEPTED' });
  if (Object.keys(r.headers).some((k) => k.toLowerCase().startsWith('x-hon-') && k !== 'x-hon-human-command') || r.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  if (r.method === 'GET' && r.body !== undefined && r.body !== null && !(typeof r.body === 'object' && !Object.keys(r.body).length)) throw new BadRequestException({ code: 'RANK_SETUP_SELECTORS_NOT_ACCEPTED' });
  return super.canActivate(context);
 }
}

/** Closed bodies; the service validates every field again with the contract checks and the database checks a third time. */
export class RankSetupProgramDto { @Allow() declare name: string }
export class RankSetupProgramRenameDto { @Allow() declare expectedVersion: number; @Allow() declare name: string }
export class RankSetupRankDto { @Allow() declare name: string; @Allow() declare color: string | null }
export class RankSetupRankUpdateDto { @Allow() declare expectedVersion: number; @Allow() declare name: string; @Allow() declare color: string | null }
export class RankSetupRankMoveDto { @Allow() declare expectedVersion: number; @Allow() declare direction: 'UP' | 'DOWN' }

/** Rank setup (0622): a school's programs and belt ladders. The organization comes from the verified scope only. */
@Controller('staff/schools/:schoolId/rank-setup')
@UseGuards(HonIdentityGuard, RankSetupHumanUiGuard)
export class StaffRankSetupController {
 constructor(private readonly database: RuntimeDatabaseService, private readonly service: RankSetupService) {}
 private async context(request: HonRequest, schoolId: string, key?: string): Promise<CurriculumResourceContext> {
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  const scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'curriculum.manage');
  if (!scope || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'RANK_SETUP_SCOPE_DENIED' });
  const id = randomUUID();
  return { ...scope, externalSubject: request.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key ?? '' };
 }
 private async run(request: HonRequest, school: string, key: string | undefined, op: RankSetupOperation, program: string | null, rank: string | null, body: object) {
  const c = await this.context(request, school, key);
  const r = await this.service.command(c, op, program, rank, { ...body });
  return { data: r.record, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed: r.replayed } };
 }
 @Get() @Header('Cache-Control', 'private, no-store')
 async read(@Param('schoolId', new ParseUUIDPipe()) school: string, @Req() request: HonRequest) {
  const c = await this.context(request, school);
  return { data: await this.service.read(c), meta: { requestId: c.requestId, correlationId: c.correlationId, replayed: false } };
 }
 @Post('programs') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 createProgram(@Param('schoolId', new ParseUUIDPipe()) school: string, @Headers('idempotency-key') key: string | undefined, @Body() body: RankSetupProgramDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'PROGRAM_CREATE', null, null, body);
 }
 @Post('programs/:programId/versions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 renameProgram(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('programId', new ParseUUIDPipe()) program: string, @Headers('idempotency-key') key: string | undefined, @Body() body: RankSetupProgramRenameDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'PROGRAM_RENAME', program, null, body);
 }
 @Post('programs/:programId/ranks') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 addRank(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('programId', new ParseUUIDPipe()) program: string, @Headers('idempotency-key') key: string | undefined, @Body() body: RankSetupRankDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'RANK_ADD', program, null, body);
 }
 @Post('programs/:programId/ranks/:rankId/versions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 updateRank(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('programId', new ParseUUIDPipe()) program: string, @Param('rankId', new ParseUUIDPipe()) rank: string, @Headers('idempotency-key') key: string | undefined, @Body() body: RankSetupRankUpdateDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'RANK_UPDATE', program, rank, body);
 }
 @Post('programs/:programId/ranks/:rankId/move') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 moveRank(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('programId', new ParseUUIDPipe()) program: string, @Param('rankId', new ParseUUIDPipe()) rank: string, @Headers('idempotency-key') key: string | undefined, @Body() body: RankSetupRankMoveDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'RANK_MOVE', program, rank, body);
 }
}
