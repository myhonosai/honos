import { BadRequestException, Body, Controller, ForbiddenException, Get, Header, HttpCode, Injectable, Post, Query, Req, UseGuards } from '@nestjs/common';
import { HonIdentityGuard } from '../foundation/hon-identity.guard.js';
import type { HonRequest } from '../foundation/hon-identity.service.js';
import { MembershipActivationHumanUiGuard } from '../billing/membership-activation-human-ui.guard.js';
import { ParentFamilyPickerService } from './parent-family-picker.service.js';

/** 0471: the list is a GET; choosing is its own same-origin browser command. */
@Injectable()
export class ParentFamilyPickerReadGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.family.read';
}
@Injectable()
export class ParentFamilyPickerSelectGuard extends MembershipActivationHumanUiGuard {
  protected override readonly command: string = 'parent.family.select';
}

function noSelectors(request: HonRequest, query: Record<string, unknown>): void {
  if (Object.keys(query).length || request.originalUrl?.includes('?')) throw new BadRequestException({ code: 'PARENT_FAMILY_SELECTORS_NOT_ACCEPTED' });
  if (!request.honIdentity) throw new ForbiddenException({ code: 'IDENTITY_REQUIRED' });
}

@Controller('parent/families')
@UseGuards(HonIdentityGuard)
export class ParentFamilyPickerController {
  constructor(private readonly picker: ParentFamilyPickerService) {}

  @Get()
  @UseGuards(ParentFamilyPickerReadGuard)
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async choices(@Query() query: Record<string, unknown>, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.picker.choices(request.honIdentity!.externalSubject) };
  }

  @Post('current')
  @HttpCode(200)
  @UseGuards(ParentFamilyPickerSelectGuard)
  @Header('Cache-Control', 'private, no-store')
  async select(@Query() query: Record<string, unknown>, @Body() body: unknown, @Req() request: HonRequest) {
    noSelectors(request, query);
    return { data: await this.picker.select(request.honIdentity!.externalSubject, body) };
  }
}
