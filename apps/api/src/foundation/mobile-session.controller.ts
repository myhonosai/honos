import { BadRequestException, Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, MobileHandoffUnavailableError, exchangeMobileHandoff, exchangeStaffMobileHandoff, sessionConfig, type MobileHandoffRedeemer } from '@hon/auth';
import { RuntimeDatabaseService } from './runtime-database.service.js';

/**
 * M2 (family app) and S0 (staff app): each native app trades the one-minute hand-off code from /auth/mobile/finish, plus its PKCE verifier,
 * for a mobile session. No cookie, no identity guard: the code and the verifier together are the proof. Each code is
 * single use: hon.redeem_mobile_handoff (0655) must record it before a session is issued, so a replay is refused.
 */
@Controller('auth/mobile')
export class MobileSessionController {
  constructor(private readonly runtime: RuntimeDatabaseService) {}

  private readonly redeem: MobileHandoffRedeemer = redemption => this.runtime.redeemMobileHandoff(redemption.app, redemption.jti, redemption.expiresAt);

  @Post('session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  exchange(@Body() body: unknown, @Req() request: { headers: Record<string, unknown> }) {
    return trade(body, request, exchangeMobileHandoff, this.redeem);
  }

  /** S0: the HON Staff app's exchange. A family code is refused here and a staff code is refused above. */
  @Post('staff-session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  exchangeStaff(@Body() body: unknown, @Req() request: { headers: Record<string, unknown> }) {
    return trade(body, request, exchangeStaffMobileHandoff, this.redeem);
  }
}

async function trade(body: unknown, request: { headers: Record<string, unknown> }, exchange: typeof exchangeMobileHandoff, redeem: MobileHandoffRedeemer) {
    const h = request.headers;
    if (h.origin !== undefined || h['sec-fetch-site'] !== undefined || h.cookie !== undefined || h.authorization !== undefined
      || !/^application\/json(?:\s*;|$)/i.test(String(h['content-type'] ?? ''))) throw new ForbiddenException({ code: 'NATIVE_APP_REQUIRED' });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException({ code: 'MOBILE_SESSION_INPUT_INVALID' });
    const keys = Object.keys(body);
    if (keys.length !== 2 || !keys.includes('code') || !keys.includes('verifier')) throw new BadRequestException({ code: 'MOBILE_SESSION_INPUT_INVALID' });
    const { code, verifier } = body as { code: unknown; verifier: unknown };
    let config;
    try { config = sessionConfig(); } catch (e) {
      if (e instanceof AuthConfigurationError) throw new ServiceUnavailableException({ code: 'IDENTITY_NOT_CONFIGURED' });
      throw e;
    }
    try { return { data: await exchange(code, verifier, redeem, config) }; }
    catch (e) {
      if (e instanceof MobileHandoffUnavailableError) throw new ServiceUnavailableException({ code: 'MOBILE_SIGN_IN_UNAVAILABLE', detail: 'Try again in a moment.' });
      throw new UnauthorizedException({ code: 'MOBILE_SIGN_IN_INVALID', detail: 'Sign in again from the app.' });
    }
}
