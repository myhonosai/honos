import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import {
  StudentImportDecideHumanUiGuard,
  StudentImportFinalizeHumanUiGuard,
  StudentImportReadHumanUiGuard,
  StudentImportStageHumanUiGuard,
} from './student-import-human-ui.guard.js';
import { StudentImportService, type StudentImportContext } from './student-import.service.js';

const PERMISSION = 'students.import';

/**
 * Student and guardian CSV import (0226). Route identifiers are never authority: the route scope is resolved from the
 * verified session, and each protected database function re-proves the direct human subject and the live permission.
 * Bodies are read raw (no DTO coercion) and validated closed in the service and again in the database.
 */
@Controller('organizations/:organizationId/schools/:schoolId/student-imports')
@UseGuards(HonIdentityGuard)
export class StudentImportController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly imports: StudentImportService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(StudentImportReadHumanUiGuard)
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.imports.list(context), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Get(':batchId')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(StudentImportReadHumanUiGuard)
  async detail(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('batchId', new ParseUUIDPipe()) batchId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() request: HonRequest) {
    if (idempotencyKey !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const context = await this.context(request, organizationId, schoolId, '');
    return { data: await this.imports.detail(context, batchId), meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(StudentImportStageHumanUiGuard)
  async stage(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.stage(context, input);
    return { data: result.batch, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':batchId/decisions')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(StudentImportDecideHumanUiGuard)
  async decide(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('batchId', new ParseUUIDPipe()) batchId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.decide(context, batchId, input);
    return { data: result.batch, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':batchId/finalize')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @UseGuards(StudentImportFinalizeHumanUiGuard)
  async finalize(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('batchId', new ParseUUIDPipe()) batchId: string, @Headers('idempotency-key') idempotencyKey: string | undefined, @Body() input: unknown, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(idempotencyKey));
    const result = await this.imports.finalize(context, batchId, input);
    return { data: result.batch, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private key(idempotencyKey: string | undefined): string {
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return key;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string): Promise<StudentImportContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'STUDENT_IMPORT_INVALID' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, PERMISSION);
    if (!scope || scope.organizationId !== organizationId || scope.schoolId !== schoolId) throw new ForbiddenException('Student import is not authorized for this school.');
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
