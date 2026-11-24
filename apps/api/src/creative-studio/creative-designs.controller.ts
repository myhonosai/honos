import { Allow } from 'class-validator';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpStatus, Injectable, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CREATIVE_DESIGN_PHOTO_COMMAND, CREATIVE_DESIGN_SAVE_COMMAND, CREATIVE_DESIGN_STATUS_COMMAND, CREATIVE_DESIGNS_READ_COMMAND } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { CreativeDesignsService } from './creative-designs.service.js';

/** 0617: reads are GETs; save, archive/restore and photo upload are each their own same-origin browser command. */
@Injectable()
export class CreativeDesignsReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CREATIVE_DESIGNS_READ_COMMAND;
}
@Injectable()
export class CreativeDesignSaveGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CREATIVE_DESIGN_SAVE_COMMAND;
}
@Injectable()
export class CreativeDesignStatusGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CREATIVE_DESIGN_STATUS_COMMAND;
}
@Injectable()
export class CreativeDesignPhotoGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = CREATIVE_DESIGN_PHOTO_COMMAND;
}

/** Every field is closed-validated by the shared contract validator in the service. */
export class SaveCreativeDesignDto {
  @Allow() designId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() name?: unknown;
  @Allow() sizeCode?: unknown;
  @Allow() document?: unknown;
}
export class SetCreativeDesignStatusDto {
  @Allow() expectedVersion?: unknown;
  @Allow() status?: unknown;
}
export class AddCreativeDesignPhotoDto {
  @Allow() mediaType?: unknown;
  @Allow() data?: unknown;
}

function definedFields(input: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined));
}

/**
 * The school's saved designs and photos (Creative Studio design editor). Route identifiers are never authority: the
 * guarded boundary resolves the scope from the verified session with the needed permission, and every database call
 * re-proves it.
 */
@Controller('organizations/:organizationId/schools/:schoolId/creative-studio/designs')
@UseGuards(HonIdentityGuard)
export class CreativeDesignsController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly designs: CreativeDesignsService) {}

  @Get()
  @UseGuards(CreativeDesignsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Query() query: Record<string, unknown>, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    const input: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(query ?? {})) {
      if (name !== 'status' || typeof value !== 'string') throw new BadRequestException({ code: 'VALIDATION_FAILED' });
      input[name] = value;
    }
    const context = await this.context(request, organizationId, schoolId, '', 'creative.design.read');
    return { data: await this.designs.list(context, input), meta: { requestId: context.requestId } };
  }

  @Get('photos/:photoId')
  @UseGuards(CreativeDesignsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async photo(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('photoId', new ParseUUIDPipe()) photoId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.readContext(request, organizationId, schoolId, key);
    return { data: await this.designs.photo(context, photoId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  @Get(':designId')
  @UseGuards(CreativeDesignsReadGuard)
  @Header('Cache-Control', 'private, no-store')
  async get(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('designId', new ParseUUIDPipe()) designId: string, @Headers('idempotency-key') key: string | undefined, @Req() request: HonRequest) {
    const context = await this.readContext(request, organizationId, schoolId, key);
    return { data: await this.designs.get(context, designId.toLowerCase()), meta: { requestId: context.requestId } };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreativeDesignSaveGuard)
  @Header('Cache-Control', 'private, no-store')
  async save(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: SaveCreativeDesignDto, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, key), 'creative.design.manage');
    const result = await this.designs.save(context, definedFields(body));
    return { data: result.design, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post('photos')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreativeDesignPhotoGuard)
  @Header('Cache-Control', 'private, no-store')
  async addPhoto(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') key: string | undefined, @Body() body: AddCreativeDesignPhotoDto, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, key), 'creative.design.manage');
    const result = await this.designs.addPhoto(context, definedFields(body));
    return { data: result.photo, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  @Post(':designId/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CreativeDesignStatusGuard)
  @Header('Cache-Control', 'private, no-store')
  async setStatus(@Param('organizationId', new ParseUUIDPipe()) organizationId: string, @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Param('designId', new ParseUUIDPipe()) designId: string, @Headers('idempotency-key') key: string | undefined,
    @Body() body: SetCreativeDesignStatusDto, @Req() request: HonRequest) {
    const context = await this.context(request, organizationId, schoolId, this.key(request, key), 'creative.design.manage');
    const result = await this.designs.setStatus(context, { ...definedFields(body), designId: designId.toLowerCase() });
    return { data: result.design, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: result.replayed } };
  }

  private async readContext(request: HonRequest, organizationId: string, schoolId: string, key: string | undefined): Promise<MembershipLifecycleContext> {
    if (key !== undefined) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    return this.context(request, organizationId, schoolId, '', 'creative.design.read');
  }

  private key(request: HonRequest, key: string | undefined): string {
    if (Object.keys(request.query ?? {}).length) throw new BadRequestException({ code: 'VALIDATION_FAILED' });
    const trimmed = key?.trim();
    if (!trimmed || trimmed !== key || trimmed.length > 200) throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    return trimmed;
  }

  private async context(request: HonRequest, organizationId: string, schoolId: string, idempotencyKey: string, permission: string): Promise<MembershipLifecycleContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId.toLowerCase() !== organizationId.toLowerCase() || scope.schoolId.toLowerCase() !== schoolId.toLowerCase()) {
      throw new ForbiddenException({ code: 'CREATIVE_DESIGN_FORBIDDEN' });
    }
    const requestId = randomUUID();
    return { ...scope, principalType: 'HUMAN_USER', requestId, correlationId: requestId, idempotencyKey, source: 'HUMAN_UI', externalSubject: identity.externalSubject };
  }
}
