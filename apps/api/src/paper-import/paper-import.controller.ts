import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  PaperImportCreateHumanUiGuard,
  PaperImportDeleteHumanUiGuard,
  PaperImportPageHumanUiGuard,
  PaperImportReadHumanUiGuard,
  PaperImportReadingHumanUiGuard,
  PaperImportSaveHumanUiGuard,
  PaperImportSendHumanUiGuard,
} from './paper-import-human-ui.guard.js';
import { PaperImportService, type PaperImportContext } from './paper-import.service.js';

const PERMISSION = 'students.import';

/**
 * Paper import (0388): photos or scans read into a table that staff check, then sent to the existing staged import.
 * Route identifiers are never authority: the route scope is resolved from the verified session, and each protected
 * database function re-proves the direct human subject and the live permission. Bodies are read raw and validated closed
 * in the service and again in the database. Every answer is private and never cached.
 */
@Controller('organizations/:organizationId/schools/:schoolId/paper-imports')
@UseGuards(HonIdentityGuard)
export class PaperImportController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly imports: PaperImportService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.noKey(idempotencyKey));
    return { data: await this.imports.list(context), meta: this.meta(context) };
  }

  @Get(':setId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportReadHumanUiGuard)
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.noKey(idempotencyKey));
    return { data: await this.imports.detail(context, setId), meta: this.meta(context) };
  }

  @Get(':setId/pages/:pageNo')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportReadHumanUiGuard)
  async page(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Param('pageNo') pageNo: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.noKey(idempotencyKey));
    return { data: await this.imports.page(context, setId, pageNo), meta: this.meta(context) };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportCreateHumanUiGuard)
  async create(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.create(context, input);
    return { data: result.set, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post(':setId/pages')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportPageHumanUiGuard)
  async addPage(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.addPage(context, setId, input);
    return { data: result.set, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  /** One reading per set, so no Idempotency-Key: a repeat returns the table already read. */
  @Post(':setId/reading')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportReadingHumanUiGuard)
  async reading(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.noKey(idempotencyKey));
    return { data: await this.imports.readPages(context, setId, input), meta: this.meta(context) };
  }

  @Post(':setId/table')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportSaveHumanUiGuard)
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.save(context, setId, input);
    return { data: result.set, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post(':setId/send')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportSendHumanUiGuard)
  async send(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.send(context, setId, input);
    return { data: result.set, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  @Post(':setId/delete')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(PaperImportDeleteHumanUiGuard)
  async remove(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('setId', new ParseUUIDPipe()) setId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.remove(context, setId, input);
    return { data: result.set, meta: { ...this.meta(context), replayed: result.replayed } };
  }

  private meta(context: PaperImportContext) { return { requestId: context.requestId, correlationId: context.correlationId }; }

  private noKey(idempotencyKey: string | undefined): string {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    return '';
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<PaperImportContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'PAPER_IMPORT_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Paper import is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
