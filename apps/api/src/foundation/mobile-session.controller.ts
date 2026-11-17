import { BadRequestException, Body, Controller, ForbiddenException, Header, HttpCode, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthConfigurationError, exchangeMobileHandoff, sessionConfig } from '@hon/auth';

/**
 * M2: the HON Parent app trades the one-minute hand-off code from /auth/mobile/finish, plus its PKCE verifier,
 * for a mobile session. No cookie, no identity guard: the code and the verifier together are the proof.
 */
@Controller('auth/mobile')
export class MobileSessionController {
  @Post('session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  exchange(@Body() body: unknown, @Req() request: { headers: Record<string, unknown> }) {
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
    try { return { data: exchangeMobileHandoff(code, verifier, config) }; }
    catch { throw new UnauthorizedException({ code: 'MOBILE_SIGN_IN_INVALID', detail: 'Sign in again from the app.' }); }
  }
}
