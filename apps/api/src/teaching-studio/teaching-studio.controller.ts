import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TeachingStudioContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { TeachingStudioService, teachingId } from './teaching-studio.service.js';
import { TeachingAssessmentDto, TeachingLessonDto, TeachingResourceDto, TeachingStudioHumanUiGuard } from './teaching-studio.dto.js';

function query(input: Record<string, unknown>, allowed: string[]) {
  if (!input || Object.keys(input).some(key => !['schoolId', ...allowed].includes(key))) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  teachingId(input.schoolId);
}
function before(input: Record<string, unknown>) {
  if (input.before === undefined) return null;
  if (typeof input.before !== 'string' || !/^[1-9][0-9]{0,8}$/.test(input.before)) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  return Number(input.before);
}
@Controller('staff/teaching-studio')
@UseGuards(HonIdentityGuard, TeachingStudioHumanUiGuard)
export class TeachingStudioController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly teaching: TeachingStudioService) {}
  private async context(request: HonRequest, input: Record<string, unknown>, allowed: string[], key = ''): Promise<TeachingStudioContext> {
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' }); query(input, allowed);
    const externalSubject = request.honIdentity.externalSubject;
    const scope = await this.database.resolveTeachingStudioScope(externalSubject, input.schoolId as string);
    if (!scope) throw new ForbiddenException({ code: 'TEACHING_STUDIO_SCOPE_DENIED' });
    const id = randomUUID();
    return { ...scope, externalSubject, principalType: 'HUMAN_USER', source: 'HUMAN_UI', requestId: id, correlationId: id, idempotencyKey: key };
  }
  private envelope<T>(context: TeachingStudioContext, data: T, replayed = false) { return { data, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed } }; }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('access')
  async access(@Query() input: Record<string, unknown>, @Req() request: HonRequest) { const context = await this.context(request, input, []); return this.envelope(context, await this.teaching.access(context)); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('lessons')
  async lessons(@Query() input: Record<string, unknown>, @Req() request: HonRequest) { const context = await this.context(request, input, []); return this.envelope(context, await this.teaching.lessons(context)); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('lessons/:id/history')
  async lessonHistory(@Param('id') id: string, @Query() input: Record<string, unknown>, @Req() request: HonRequest) { teachingId(id); const context = await this.context(request, input, ['before']); return this.envelope(context, await this.teaching.history(context, 'LESSON', id, null, before(input))); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('lessons') @HttpCode(200)
  async createLesson(@Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingLessonDto, @Req() request: HonRequest) { const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveLesson(context, null, body); return this.envelope(context, result.result, result.replayed); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('lessons/:id/revisions') @HttpCode(200)
  async reviseLesson(@Param('id') id: string, @Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingLessonDto, @Req() request: HonRequest) { teachingId(id); const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveLesson(context, id, body); return this.envelope(context, result.result, result.replayed); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('resources')
  async resources(@Query() input: Record<string, unknown>, @Req() request: HonRequest) { const context = await this.context(request, input, []); return this.envelope(context, await this.teaching.resources(context)); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('resources/:id/history')
  async resourceHistory(@Param('id') id: string, @Query() input: Record<string, unknown>, @Req() request: HonRequest) { teachingId(id); const context = await this.context(request, input, ['before']); return this.envelope(context, await this.teaching.history(context, 'RESOURCE', id, null, before(input))); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('resources') @HttpCode(200)
  async createResource(@Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingResourceDto, @Req() request: HonRequest) { const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveResource(context, null, body); return this.envelope(context, result.result, result.replayed); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('resources/:id/revisions') @HttpCode(200)
  async reviseResource(@Param('id') id: string, @Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingResourceDto, @Req() request: HonRequest) { teachingId(id); const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveResource(context, id, body); return this.envelope(context, result.result, result.replayed); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('students/:student/assessments')
  async assessments(@Param('student') student: string, @Query() input: Record<string, unknown>, @Req() request: HonRequest) { teachingId(student); const context = await this.context(request, input, []); return this.envelope(context, await this.teaching.assessments(context, student)); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Get('students/:student/assessments/:id/history')
  async assessmentHistory(@Param('student') student: string, @Param('id') id: string, @Query() input: Record<string, unknown>, @Req() request: HonRequest) { teachingId(student); teachingId(id); const context = await this.context(request, input, ['before']); return this.envelope(context, await this.teaching.history(context, 'ASSESSMENT', id, student, before(input))); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('students/:student/assessments') @HttpCode(200)
  async createAssessment(@Param('student') student: string, @Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingAssessmentDto, @Req() request: HonRequest) { teachingId(student); const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveAssessment(context, student, null, body); return this.envelope(context, result.result, result.replayed); }
  @Header('Cache-Control', 'private, no-store') @Header('Referrer-Policy', 'no-referrer') @Post('students/:student/assessments/:id/revisions') @HttpCode(200)
  async reviseAssessment(@Param('student') student: string, @Param('id') id: string, @Query() input: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Body() body: TeachingAssessmentDto, @Req() request: HonRequest) { teachingId(student); teachingId(id); const context = await this.context(request, input, [], key ?? ''); const result = await this.teaching.saveAssessment(context, student, id, body); return this.envelope(context, result.result, result.replayed); }
}
