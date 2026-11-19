import { Body, Controller, Get, Headers, HttpCode, Injectable, Param, Post, Req, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { POS_HUMAN_COMMAND } from '@hon/contracts';
import { assertSchoolAccountHumanRequest } from '../accounts/school-staff-invitation.controller.js';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { SchoolPosService } from './school-pos.service.js';

/** 0564: same-origin human browser requests only, with their own command header for writes; never cached. */
@Injectable()
export class SchoolPosHumanGuard implements CanActivate {
  canActivate(c: ExecutionContext) { return assertSchoolAccountHumanRequest(c, POS_HUMAN_COMMAND); }
}

@Controller() @UseGuards(SchoolPosHumanGuard, HonIdentityGuard)
export class SchoolPosController {
  constructor(private readonly pos: SchoolPosService) {}
  @Get('school/schools/:schoolId/pos')
  read(@Req() r: HonRequest, @Param('schoolId') s: string) { return this.pos.read(r, s).then(data => ({ data })); }
  @Get('school/schools/:schoolId/pos/sales/:from/:to')
  sales(@Req() r: HonRequest, @Param('schoolId') s: string, @Param('from') f: string, @Param('to') t: string) { return this.pos.sales(r, s, f, t).then(data => ({ data })); }
  @Get('school/schools/:schoolId/pos/sale/:saleId')
  sale(@Req() r: HonRequest, @Param('schoolId') s: string, @Param('saleId') id: string) { return this.pos.sale(r, s, id).then(data => ({ data })); }
  @Post('school/pos/settings') @HttpCode(200)
  settings(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.pos.command(r, 'settings', b, k).then(data => ({ data })); }
  @Post('school/pos/items') @HttpCode(200)
  item(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.pos.command(r, 'item', b, k).then(data => ({ data })); }
  @Post('school/pos/stock') @HttpCode(200)
  stock(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.pos.command(r, 'stock', b, k).then(data => ({ data })); }
  @Post('school/pos/sales') @HttpCode(200)
  record(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.pos.command(r, 'record', b, k).then(data => ({ data })); }
  @Post('school/pos/refunds') @HttpCode(200)
  refund(@Req() r: HonRequest, @Body() b: unknown, @Headers('idempotency-key') k: string) { return this.pos.command(r, 'refund', b, k).then(data => ({ data })); }
}
