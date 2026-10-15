import { Allow } from 'class-validator';
import { Injectable } from '@nestjs/common';
import type { MarketplaceInput, MarketplaceModule } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
export class MarketplaceDto implements MarketplaceInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare title: string;
  @Allow() declare category: MarketplaceInput['category'];
  @Allow() declare assetKind: MarketplaceInput['assetKind'];
  @Allow() declare targetModule: MarketplaceModule;
  @Allow() declare requiredPermissions: string[];
  @Allow() declare releaseNotes: string;
  @Allow() declare previewText: string;
  @Allow() declare status: MarketplaceInput['status'];
}
export class MarketplaceSelectionDto {
  @Allow() declare expectedVersion: 0;
  @Allow() declare assetVersion: number;
}
@Injectable()
export class MarketplaceHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'marketplace';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
