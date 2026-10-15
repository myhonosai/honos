import { Allow } from 'class-validator';
import { Injectable, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { CommunityInput, CommunityKind, CommunityStatus, CommunityProfileInput, CommunityConsentInput } from '@hon/contracts';
import { CurriculumHumanUiGuard } from '../curriculum/curriculum-human-ui.guard.js';
export class CommunityDto implements CommunityInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare kind: CommunityKind;
  @Allow() declare parentId: string | null;
  @Allow() declare title: string;
  @Allow() declare body: string;
  @Allow() declare status: CommunityStatus;
  @Allow() declare reason: string;
}
export class CommunityProfileDto implements CommunityProfileInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare displayName: string;
  @Allow() declare enabled: boolean;
}
export class CommunityConsentDto implements CommunityConsentInput {
  @Allow() declare expectedVersion: number;
  @Allow() declare enabled: boolean;
}
@Injectable()
export class CommunityHumanUiGuard extends CurriculumHumanUiGuard {
  protected readonly command = 'community';
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; headers: Record<string, unknown> }>();
    if (req.method !== 'GET' && req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin') throw new ForbiddenException({ code: 'HUMAN_UI_REQUIRED' });
    return super.canActivate(context);
  }
}
