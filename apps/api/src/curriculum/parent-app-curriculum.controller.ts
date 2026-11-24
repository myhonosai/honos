import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { PARENT_APP_CURRICULUM_COMMAND, type CurriculumResourceContext, type ParentAppCurriculumOperation } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { CurriculumHumanUiGuard } from './curriculum-human-ui.guard.js';
import { ParentCurriculumLibraryReadGuard, rejectParentLibraryInputs } from './library.controller.js';
import { CurriculumAppSettingsDto, CurriculumCycleCreateDto, CurriculumCycleOrderDto, CurriculumCycleRenameDto, CurriculumCycleVersionDto } from './parent-app-curriculum.dto.js';
import { ParentAppCurriculumService } from './parent-app-curriculum.service.js';

/** Same rules as the library guard (no selectors, no X-Hon-* but the command, same-origin POST), with its own command name. */
@Injectable()
export class ParentAppCurriculumHumanUiGuard extends CurriculumHumanUiGuard {
 protected readonly command: string = PARENT_APP_CURRICULUM_COMMAND;
 canActivate(context: ExecutionContext): boolean {
  const r = context.switchToHttp().getRequest<Request>();
  if (r.originalUrl?.includes('?') || Object.keys(r.query ?? {}).length) throw new BadRequestException({ code: 'PARENT_APP_CURRICULUM_SELECTORS_NOT_ACCEPTED' });
  if (Object.keys(r.headers).some((k) => k.toLowerCase().startsWith('x-hon-') && k !== 'x-hon-human-command') || r.headers['sec-fetch-site'] === 'cross-site') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
  if (r.method === 'GET' && r.body !== undefined && r.body !== null && !(typeof r.body === 'object' && !Object.keys(r.body).length)) throw new BadRequestException({ code: 'PARENT_APP_CURRICULUM_SELECTORS_NOT_ACCEPTED' });
  return super.canActivate(context);
 }
}

@Controller('staff/schools/:schoolId/parent-app/curriculum')
@UseGuards(HonIdentityGuard, ParentAppCurriculumHumanUiGuard)
export class StaffParentAppCurriculumController {
 constructor(private readonly database: RuntimeDatabaseService, private readonly service: ParentAppCurriculumService) {}
 private async context(request: HonRequest, schoolId: string, key?: string): Promise<CurriculumResourceContext> {
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  const scope = await this.database.resolveAuthorizedScope(request.honIdentity.externalSubject, schoolId, 'curriculum.manage');
  if (!scope || scope.schoolId !== schoolId) throw new ForbiddenException({ code: 'PARENT_APP_CURRICULUM_SCOPE_DENIED' });
  const id = randomUUID();
  return { ...scope, externalSubject: request.honIdentity.externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key ?? '' };
 }
 private async run(request: HonRequest, school: string, key: string | undefined, op: ParentAppCurriculumOperation, curriculum: string, target: string | null, body: object) {
  const c = await this.context(request, school, key);
  const r = await this.service.command(c, op, curriculum, target, { ...body });
  return { data: r.record, meta: { requestId: c.requestId, correlationId: c.correlationId, replayed: r.replayed } };
 }
 @Get() @Header('Cache-Control', 'private, no-store')
 async read(@Param('schoolId', new ParseUUIDPipe()) school: string, @Req() request: HonRequest) {
  const c = await this.context(request, school);
  return { data: await this.service.read(c), meta: { requestId: c.requestId, correlationId: c.correlationId, replayed: false } };
 }
 @Get('preview/:studentId') @Header('Cache-Control', 'private, no-store')
 async preview(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('studentId', new ParseUUIDPipe()) student: string, @Req() request: HonRequest) {
  const c = await this.context(request, school);
  return { data: await this.service.preview(c, student), meta: { requestId: c.requestId, correlationId: c.correlationId, replayed: false } };
 }
 @Post(':curriculumId/settings') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 settings(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumAppSettingsDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'SAVE_SETTINGS', curriculum, null, body);
 }
 @Post(':curriculumId/cycles') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 createCycle(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumCycleCreateDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'CYCLE_CREATE', curriculum, null, body);
 }
 @Post(':curriculumId/cycles/:cycleId/versions') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 renameCycle(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Param('cycleId', new ParseUUIDPipe()) cycle: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumCycleRenameDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'CYCLE_RENAME', curriculum, cycle, body);
 }
 @Post(':curriculumId/cycles/:cycleId/archive') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 archiveCycle(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Param('cycleId', new ParseUUIDPipe()) cycle: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumCycleVersionDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'CYCLE_ARCHIVE', curriculum, cycle, body);
 }
 @Post(':curriculumId/cycles/:cycleId/switch') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 switchCycle(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Param('cycleId', new ParseUUIDPipe()) cycle: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumCycleVersionDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'SWITCH_CYCLE', curriculum, cycle, body);
 }
 @Post(':curriculumId/cycle-order') @HttpCode(200) @Header('Cache-Control', 'private, no-store')
 orderCycles(@Param('schoolId', new ParseUUIDPipe()) school: string, @Param('curriculumId', new ParseUUIDPipe()) curriculum: string, @Headers('idempotency-key') key: string | undefined, @Body() body: CurriculumCycleOrderDto, @Req() request: HonRequest) {
  return this.run(request, school, key, 'CYCLE_ORDER', curriculum, null, body);
 }
}

/** Selector-free, read-only parent route (cookie or mobile bearer): the family comes from the signed-in subject only. */
@Controller('parent/curriculum-app')
@UseGuards(HonIdentityGuard, ParentCurriculumLibraryReadGuard)
export class ParentCurriculumAppController {
 constructor(private readonly service: ParentAppCurriculumService) {}
 @Get() @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Header('X-Robots-Tag', 'noindex, nofollow')
 async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
  rejectParentLibraryInputs(request, query);
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
  return this.service.parent(request.honIdentity.externalSubject);
 }
}
