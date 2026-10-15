import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@hon/contracts';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { UpdateInterfaceThemeDto } from './interface-theme.dto.js';
import { InterfaceThemeService } from './interface-theme.service.js';

@Controller('organizations/:organizationId/schools/:schoolId/interface-theme')
@UseGuards(HonIdentityGuard)
export class InterfaceThemeController {
  constructor(private readonly database: RuntimeDatabaseService, private readonly preferences: InterfaceThemeService) {}

  private async context(request: HonRequest, organizationId: string, schoolId: string, permission: string, idempotencyKey: string): Promise<CommandContext> {
    const identity = request.honIdentity;
    if (!identity) throw new ForbiddenException('HON identity context is missing.');
    const scope = await this.database.resolveAuthorizedScope(identity.externalSubject, schoolId, permission);
    if (!scope || scope.organizationId !== organizationId) throw new ForbiddenException('HON interface preference access is not authorized for this school.');
    const requestId = randomUUID();
    return {
      organizationId: scope.organizationId,
      schoolId: scope.schoolId,
      principalId: scope.principalId,
      principalType: 'HUMAN_USER',
      requestId,
      correlationId: requestId,
      idempotencyKey,
      source: 'HUMAN_UI',
    };
  }

  @Get()
  async get(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Req() request: HonRequest,
  ) {
    const context = await this.context(request, organizationId, schoolId, 'settings.interface_theme.read', `read:${randomUUID()}`);
    const preference = await this.preferences.get(context);
    return { data: preference, meta: { requestId: context.requestId, correlationId: context.correlationId } };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  async save(
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: UpdateInterfaceThemeDto,
    @Req() request: HonRequest,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required for an interface preference update.' });
    }
    const context = await this.context(request, organizationId, schoolId, 'settings.interface_theme.update', idempotencyKey);
    const preference = await this.preferences.save(context, {
      interfaceTheme: input.interfaceTheme,
      selectedVia: input.selectedVia ?? 'SETTINGS',
    });
    return { data: preference, meta: { requestId: context.requestId, correlationId: context.correlationId, replayed: preference.replayed ?? false } };
  }
}
