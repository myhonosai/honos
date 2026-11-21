import { Body, Controller, Get, Header, Headers, Injectable, NotFoundException, Param, Post, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { validatePublicFormSubmission, verifyPublicReferral, type PublicFormResult, type PublicReferral } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

const CODE = /^[0-9a-f]{16}$/;

/**
 * 0604 public referral page: what a friend sees (school name, the friend offer, the school's form; never the referring
 * family) and the friend's submission through the unchanged 0075 intake. Same closed answers as public forms.
 */
@Injectable()
export class PublicReferralService {
  constructor(private readonly database: RuntimeDatabaseService) {}
  async read(code: string): Promise<PublicReferral | null> {
    if (typeof code !== 'string' || !CODE.test(code)) return null;
    try {
      const data = await this.database.runPublicEventCall('SELECT hon.read_public_referral($1) AS data', [code]);
      return data === null ? null : verifyPublicReferral(data);
    } catch { throw new ServiceUnavailableException({ result: 'unavailable' }); }
  }
  async submit(code: string, input: unknown, key: unknown): Promise<PublicFormResult> {
    if (typeof code !== 'string' || !CODE.test(code) || typeof key !== 'string' || key.trim() !== key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) return 'invalid';
    try { validatePublicFormSubmission(input); if (Buffer.byteLength(JSON.stringify(input)) > 8192) return 'invalid'; }
    catch { return 'invalid'; }
    try {
      const result = await this.database.runPublicEventCall('SELECT hon.submit_family_referral($1,$2::jsonb,$3) AS data', [code, JSON.stringify(input), key]);
      return result === 'ACCEPTED' ? 'accepted' : result === 'RATE_LIMITED' ? 'rate-limited' : result === 'INVALID' ? 'invalid' : 'unavailable';
    } catch { return 'unavailable'; } // Never propagate PostgreSQL DETAIL, body, contact or lead state.
  }
}

@Controller('public/referrals')
export class PublicReferralController {
  constructor(private readonly referrals: PublicReferralService) {}
  @Get(':code') @Header('Cache-Control', 'no-store')
  async read(@Param('code') code: string) { const data = await this.referrals.read(code); if (!data) throw new NotFoundException({ result: 'invalid' }); return { data }; }
  @Post(':code/submissions') @Header('Cache-Control', 'no-store')
  async submit(@Param('code') code: string, @Body() input: unknown, @Headers('idempotency-key') key: string, @Res() res: Response) {
    const result = await this.referrals.submit(code, input, key);
    if (result === 'rate-limited') res.setHeader('Retry-After', '3600');
    return res.status(result === 'accepted' ? 202 : result === 'invalid' ? 400 : result === 'rate-limited' ? 429 : 503).json({ result });
  }
}
