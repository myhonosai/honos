import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Injectable, Param, Post, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import {
  SAAS_COMMANDS, saasUuid, validateCreativeAssetDeletion, validateCreativeAssetDeletionRecord, validateCreativeAssetReadGrant, validateCreativeAssetView,
  type CreativeAssetDeletion, type CreativeAssetView,
} from '@hon/contracts';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { emitTelemetry } from '../../observability/telemetry.js';
import { SaasCommandGuard, SaasCommandName, SaasReadGuard } from '../../saas-billing/saas-billing.guards.js';
import { SaasBillingService } from '../../saas-billing/saas-billing.service.js';
import { CREATIVE_MEDIA_LIMITS, CREATIVE_MEDIA_STORE, type CreativeMediaStore } from './creative-media-store.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * C3 reads and deletes of stored creative files. The database decides who may (exact school, the 0216 creative actor)
 * and which object; the storage key never leaves the server. A read is a 5-minute signed URL. A delete stops reads at
 * once, then removes the file; a failed removal is retried by repeating the delete.
 */
@Injectable()
export class CreativeMediaService {
  constructor(private readonly billing: SaasBillingService, @Inject(CREATIVE_MEDIA_STORE) private readonly store: CreativeMediaStore) {}

  async view(subject: string, schoolId: unknown, assetId: unknown): Promise<CreativeAssetView> {
    const [school, asset] = parse(() => [saasUuid(schoolId), saasUuid(assetId)] as const);
    if (this.store.readiness() !== 'READY') throw new ServiceUnavailableException({ code: 'CREATIVE_STORAGE_NOT_CONNECTED' });
    const grant = await this.billing.call('authorizeCreativeAssetRead', [subject, school, asset], validateCreativeAssetReadGrant);
    if (grant.assetId !== asset) throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    const seconds = CREATIVE_MEDIA_LIMITS.signedReadSeconds;
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    let url: string;
    try { url = await this.store.signedReadUrl(grant.storageKey, seconds); }
    catch { throw new ServiceUnavailableException({ code: 'CREATIVE_STORAGE_UNAVAILABLE' }); }
    try { return validateCreativeAssetView({ assetId: asset, mediaType: grant.mediaType, url, expiresAt }); }
    catch { throw new ServiceUnavailableException({ code: 'CREATIVE_STORAGE_UNAVAILABLE' }); }
  }

  async remove(subject: string, schoolId: unknown, assetId: unknown, body: unknown): Promise<CreativeAssetDeletion> {
    const [school, asset] = parse(() => [saasUuid(schoolId), saasUuid(assetId)] as const);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' });
    const record = await this.billing.call('deleteCreativeAsset', [subject, school, asset], validateCreativeAssetDeletionRecord);
    if (record.assetId !== asset) throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    let fileRemoved = record.removed;
    if (!fileRemoved && record.storageKey && this.store.readiness() === 'READY') {
      try {
        await this.store.remove(record.storageKey);
        const confirmed = await this.billing.call('confirmCreativeAssetRemoved', [subject, school, asset], validateCreativeAssetDeletionRecord);
        fileRemoved = confirmed.removed;
      } catch {
        // Reads already stopped; the file stays listed for removal and the same delete retries it.
        emitTelemetry('warn', 'creative.asset_file_removal_pending', { component: 'creative-media' });
      }
    }
    return validateCreativeAssetDeletion({ assetId: asset, deletedAt: record.deletedAt, fileRemoved });
  }
}

function subject(req: HonRequest): string {
  if (!req.honIdentity) throw new ForbiddenException({ code: 'SAAS_FORBIDDEN' });
  return req.honIdentity.externalSubject;
}

@Controller('schools/:schoolId/creative-studio/assets')
@UseGuards(HonIdentityGuard)
export class CreativeMediaController {
  constructor(private readonly media: CreativeMediaService) {}
  @Get(':assetId/view') @UseGuards(SaasReadGuard)
  async view(@Req() req: HonRequest, @Res({ passthrough: true }) res: { setHeader(name: string, value: string): void }, @Param('schoolId') schoolId: string, @Param('assetId') assetId: string) {
    res.setHeader('Cache-Control', 'private, no-store');
    return { data: await this.media.view(subject(req), schoolId, assetId) };
  }
  @Post(':assetId/delete') @HttpCode(200) @UseGuards(SaasCommandGuard) @SaasCommandName(SAAS_COMMANDS.deleteCreativeAsset)
  async remove(@Req() req: HonRequest, @Param('schoolId') schoolId: string, @Param('assetId') assetId: string, @Body() body: unknown) {
    return { data: await this.media.remove(subject(req), schoolId, assetId, body) };
  }
}
