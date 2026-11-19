import { Body, Controller, Get, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { SHOPIFY_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../../accounts/school-staff-invitation.controller.js';
import { HonIdentityGuard } from '../../foundation/hon-identity.guard.js';
import type { HonRequest } from '../../foundation/hon-identity.service.js';
import { ShopifyService } from './shopify.service.js';

/** 0405: same-origin human browser requests only, with their own command header for writes; never cached. */
@Injectable()
export class ShopifyHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, SHOPIFY_HUMAN_COMMAND); }
}

@Controller() @UseGuards(ShopifyHumanGuard, HonIdentityGuard)
export class ShopifyController {
  constructor(private readonly shopify: ShopifyService) {}
  @Get('school/schools/:schoolId/shopify')
  read(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.shopify.overview(r, s).then(data => ({ data })); }
  @Get('school/schools/:schoolId/shopify/catalog')
  catalog(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.shopify.catalog(r, s).then(data => ({ data })); }
  @Get('school/schools/:schoolId/shopify/orders')
  orders(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.shopify.orders(r, s).then(data => ({ data })); }
  @Post('school/shopify/connect') @HttpCode(200)
  start(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.start(r, b).then(data => ({ data })); }
  @Post('school/shopify/connect/complete') @HttpCode(200)
  complete(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.complete(r, b).then(data => ({ data })); }
  @Post('school/shopify/sync') @HttpCode(200)
  sync(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.sync(r, b).then(data => ({ data })); }
  @Get('school/schools/:schoolId/shopify/changes')
  changes(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.shopify.changes(r, s).then(data => ({ data })); }
  @Post('school/shopify/changes') @HttpCode(200)
  propose(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.propose(r, b).then(data => ({ data })); }
  @Post('school/shopify/changes/cancel') @HttpCode(200)
  cancelChange(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.cancelChange(r, b).then(data => ({ data })); }
  @Post('school/shopify/changes/approve') @HttpCode(200)
  approveChange(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.approveChange(r, b).then(data => ({ data })); }
  @Post('school/shopify/disconnect') @HttpCode(200)
  disconnect(@Req() r: HonRequest, @Body() b: unknown) { return this.shopify.disconnect(r, b).then(data => ({ data })); }
}
