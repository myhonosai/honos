import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException,
  SetMetadata, type CanActivate, type ExecutionContext, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { configuredPublicOrigin } from '@hon/auth';
import {
  LANGUAGE_COMMANDS, validateLanguageUpdateInput, validateMyLanguagePreferenceReceipt, validateMyLanguagePreferenceView, validateMyLanguageQuery,
  validateSchoolLanguageDefaultReceipt, validateSchoolLanguageDefaultView,
} from '@hon/contracts';
import { assertChampionsHumanRequest } from '../champions/champions-club.guards.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService, type LanguageOperation } from '../foundation/runtime-database.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND = 'hon:language-command';
const LanguageCommandName = (command: string) => SetMetadata(COMMAND, command);
function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'LANGUAGE_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}
function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_LANGUAGE_INPUT' }); }
}
function hasBody(req: HonRequest): boolean {
  const body: unknown = req.body;
  return body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0);
}

/** Reads: direct human identity, no-store, no body; only `schoolId` on the personal read. */
@Injectable()
export class LanguageReadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    assertChampionsHumanRequest(req);
    if (req.method !== 'GET' || hasBody(req)) throw new BadRequestException({ code: 'INVALID_LANGUAGE_INPUT' });
    return true;
  }
}
/** Updates: trusted same-origin human JSON with the route's exact x-hon-human-command and an Idempotency-Key. */
@Injectable()
export class LanguageCommandGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HonRequest>();
    context.switchToHttp().getResponse().setHeader('Cache-Control', 'private, no-store');
    assertChampionsHumanRequest(req);
    const command = this.reflector.get<string | undefined>(COMMAND, context.getHandler());
    let origin: string | undefined;
    try { origin = configuredPublicOrigin(process.env); } catch { /* fail closed */ }
    if (!origin) throw new ServiceUnavailableException({ code: 'HUMAN_UI_ORIGIN_NOT_CONFIGURED' });
    if (!command || req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-hon-human-command'] !== command
      || Object.keys(req.headers).some(key => key.toLowerCase().startsWith('x-hon-') && key.toLowerCase() !== 'x-hon-human-command')
      || req.headers['sec-fetch-site'] !== 'same-origin' || req.headers['sec-fetch-mode'] !== 'same-origin'
      || req.headers['sec-fetch-dest'] !== 'empty' || req.headers['sec-fetch-user'] !== undefined
      || typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
      throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    }
    if (Object.keys(req.query ?? {}).length || req.originalUrl?.includes('?')) throw new BadRequestException({ code: 'INVALID_LANGUAGE_INPUT' });
    return true;
  }
}

@Injectable()
export class LanguagePreferencesService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async readMine(subject: string, query: unknown) {
    const q = parse(() => validateMyLanguageQuery(query));
    return this.run('readMine', [subject, q.schoolId], validateMyLanguagePreferenceView);
  }
  async updateMine(subject: string, body: unknown, key: unknown) {
    const [input, k] = parse(() => [validateLanguageUpdateInput(body), this.key(key)] as const);
    return this.run('updateMine', [subject, JSON.stringify(input), k, randomUUID(), randomUUID()], validateMyLanguagePreferenceReceipt);
  }
  async readSchool(subject: string, schoolId: unknown) {
    const school = parse(() => this.uuid(schoolId));
    return this.run('readSchool', [subject, school], validateSchoolLanguageDefaultView);
  }
  async updateSchool(subject: string, schoolId: unknown, body: unknown, key: unknown) {
    const [school, input, k] = parse(() => [this.uuid(schoolId), validateLanguageUpdateInput(body), this.key(key)] as const);
    return this.run('updateSchool', [subject, school, JSON.stringify(input), k, randomUUID(), randomUUID()], validateSchoolLanguageDefaultReceipt);
  }
  private uuid(v: unknown): string { if (typeof v !== 'string' || !UUID.test(v)) throw new Error('INVALID'); return v.toLowerCase(); }
  private key(v: unknown): string { return this.uuid(v); }
  private async run<T>(operation: LanguageOperation, params: (string | null)[], validate: (value: unknown) => T): Promise<T> {
    let data: unknown;
    try { data = await this.database.callLanguage(operation, params); }
    catch (error) {
      const { code } = (error ?? {}) as { code?: string };
      if (code === '42501') throw new ForbiddenException({ code: 'LANGUAGE_FORBIDDEN' });
      if (code === '40001') throw new ConflictException({ code: 'LANGUAGE_VERSION_CONFLICT' });
      if (code === '23505') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REUSED' });
      if (code === 'P0002') throw new NotFoundException({ code: 'LANGUAGE_UNAVAILABLE' });
      if (code === '55P03' || code === '57014') throw new ConflictException({ code: 'LANGUAGE_OUTCOME_UNKNOWN', detail: 'Retry the identical request with the same key.' });
      if (['22023','22P02','23514'].includes(code ?? '')) throw new BadRequestException({ code: 'INVALID_LANGUAGE_INPUT' });
      throw new ServiceUnavailableException({ code: 'LANGUAGE_UNAVAILABLE' });
    }
    try { return validate(data); } catch { throw new ServiceUnavailableException({ code: 'LANGUAGE_UNAVAILABLE' }); }
  }
}

/** The signed-in user's own language preference. There is no user id in the path: the identity is the subject. */
@Controller('me/language-preference')
@UseGuards(HonIdentityGuard)
export class MyLanguagePreferenceController {
  constructor(private readonly languages: LanguagePreferencesService) {}
  @Get() @UseGuards(LanguageReadGuard)
  async read(@Req() req: HonRequest, @Query() query: Record<string, unknown>) {
    return { data: await this.languages.readMine(subject(req), query) };
  }
  @Post() @HttpCode(200) @UseGuards(LanguageCommandGuard) @LanguageCommandName(LANGUAGE_COMMANDS.updateMyLanguage)
  async update(@Req() req: HonRequest, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.languages.updateMine(subject(req), body, key) };
  }
}

/** A school's default language for users without a personal preference (settings.language.manage to change). */
@Controller('schools/:schoolId/language-default')
@UseGuards(HonIdentityGuard)
export class SchoolLanguageDefaultController {
  constructor(private readonly languages: LanguagePreferencesService) {}
  @Get() @UseGuards(LanguageReadGuard)
  async read(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Query() query: Record<string, unknown>) {
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'INVALID_LANGUAGE_INPUT' });
    return { data: await this.languages.readSchool(subject(req), schoolId) };
  }
  @Post() @HttpCode(200) @UseGuards(LanguageCommandGuard) @LanguageCommandName(LANGUAGE_COMMANDS.updateSchoolDefault)
  async update(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined) {
    return { data: await this.languages.updateSchool(subject(req), schoolId, body, key) };
  }
}
