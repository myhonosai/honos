import { BadRequestException, Controller, ForbiddenException, Get, Header, Injectable, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentProShopService } from './parent-pro-shop.service.js';

/** 0581: the pro shop read is its own human command; GET only. */
@Injectable()
export class ParentProShopReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.pro_shop.read';
}

/** Parent side: the school's pro shop for the signed-in family (More > Pro shop in the HON Family app). */
@Controller('parent/pro-shop')
@UseGuards(HonIdentityGuard)
export class ParentProShopController {
  constructor(private readonly shop: ParentProShopService) {}

  @Get()
  @UseGuards(ParentProShopReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async read(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    if (Object.keys(query ?? {}).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_PRO_SHOP_SELECTORS_NOT_ACCEPTED' });
    if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
    return { data: await this.shop.read(request.honIdentity.externalSubject) };
  }
}
