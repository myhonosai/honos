import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Query, Req,
  Res, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { SchoolContactAdminService } from './school-contact-admin.service.js';

/** C3 (0523): every merge / archive call is its own browser command, so none replays as another. */
@Injectable()
export class SchoolContactArchiveReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.contact.archive.read';
}
@Injectable()
export class SchoolContactArchiveGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.contact.archive';
}
@Injectable()
export class SchoolContactRestoreGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.contact.restore';
}
@Injectable()
export class SchoolContactMergePreviewGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.contact.merge.preview';
}
@Injectable()
export class SchoolContactMergeGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'people.contact.merge';
}

function idempotencyKey(key: string | undefined): string {
  if (typeof key !== 'string' || !key || key.trim() !== key || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
  }
  return key;
}

/**
 * C3 (0523): delete (archive), restore and merge on the contact card. Route identifiers are never authority: the scope is
 * resolved from the verified session for the permission the call needs, and the database re-proves it live.
 */
@Controller('organizations/:organizationId/schools/:schoolId/contacts/:personId')
@UseGuards(HonIdentityGuard)
export class SchoolContactAdminController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly admin: SchoolContactAdminService) {}

  @Get('archive')
  @UseGuards(SchoolContactArchiveReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async archiveState(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'people.archive', '');
    return { data: await this.admin.archiveState(context, personId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  @Post('archive')
  @HttpCode(201)
  @UseGuards(SchoolContactArchiveGuard)
  @Header('Cache-Control', 'private, no-store')
  async archive(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Body() body: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'people.archive', idempotencyKey(key));
    const result = await this.admin.archive(context, personId.toLowerCase(), body, false);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  @Post('restore')
  @HttpCode(201)
  @UseGuards(SchoolContactRestoreGuard)
  @Header('Cache-Control', 'private, no-store')
  async restore(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Body() body: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'people.archive', idempotencyKey(key));
    const result = await this.admin.archive(context, personId.toLowerCase(), body, true);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  /** Step 1: what merging ?mergePersonId= into this person would move, what stays, what blocks it, and the plan hash. */
  @Get('merge')
  @UseGuards(SchoolContactMergePreviewGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async mergePreview(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(query ?? {}).join() !== 'mergePersonId' || typeof query.mergePersonId !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'people.merge', '');
    return { data: await this.admin.mergePreview(context, personId.toLowerCase(), query.mergePersonId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  /** Step 2: merge at the exact versions and plan hash of the preview. */
  @Post('merge')
  @HttpCode(201)
  @UseGuards(SchoolContactMergeGuard)
  @Header('Cache-Control', 'private, no-store')
  async merge(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('personId', new ParseUUIDPipe()) personId: string, @Headers('idempotency-key') key: string | undefined, @Query() query: Record<string, unknown>,
    @Body() body: unknown, @Req() request: HonRequest, @Res({ passthrough: true }) response: Response) {
    if (Object.keys(query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const context = await this.context(request, organizationId, schoolId, 'people.merge', idempotencyKey(key));
    const result = await this.admin.merge(context, personId.toLowerCase(), body);
    response.status(result.replayed ? 200 : 201);
    return { data: result.receipt, meta: { requestId: context.requestId, replayed: result.replayed } };
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'SCHOOL_CONTACT_ADMIN_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
