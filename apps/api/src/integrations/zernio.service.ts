import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { validateZernioConfirmation, validateZernioConfiguration, validateZernioVerification, type ZernioVerification } from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import { ZERNIO_RUNTIME, type ZernioReadRuntime } from './zernio-runtime.js';

@Injectable()
export class ZernioIntegrationService {
  private verifying = false;
  constructor(private readonly database: RuntimeDatabaseService,
    @Inject(ZERNIO_RUNTIME) private readonly runtime: ZernioReadRuntime) {}

  private async owner(subject: string): Promise<void> {
    const scope = await this.database.resolveHqOperatorScope(subject, 'hq.integrations.zernio.read');
    if (!scope || scope.hqRole !== 'HON_HQ_OWNER') throw new ForbiddenException({ code: 'ZERNIO_HQ_OWNER_REQUIRED' });
  }
  async configuration(subject: string) {
    await this.owner(subject);
    return validateZernioConfiguration(this.runtime.configuration());
  }
  async verify(subject: string, body: unknown): Promise<ZernioVerification> {
    await this.owner(subject);
    try { validateZernioConfirmation(body); } catch { throw new BadRequestException({ code: 'INVALID_ZERNIO_CONFIRMATION' }); }
    if (!this.runtime.configuration().verificationEnabled) throw new ServiceUnavailableException({ code: 'ZERNIO_VERIFICATION_DISABLED' });
    if (this.verifying) throw new ConflictException({ code: 'ZERNIO_VERIFICATION_IN_PROGRESS' });
    this.verifying = true;
    try {
      const status = await this.runtime.verifyCredential();
      await this.owner(subject); // Revocation during the network wait must hide the result.
      return validateZernioVerification({ provider: 'ZERNIO', status, checkedAt: new Date().toISOString(), externalActions: 'DISABLED' });
    } finally { this.verifying = false; }
  }
}
