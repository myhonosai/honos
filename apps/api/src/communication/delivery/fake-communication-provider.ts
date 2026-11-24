import { createHash } from 'node:crypto';
import {
  fakeProviderEnabled,
  type CommunicationProviderAdapter,
  type CommunicationSendAccepted,
  type CommunicationSendRequest,
  type DeliverableChannel,
} from './communication-provider.js';

/**
 * Deterministic test provider. It never opens a network connection. READY only when
 * HON_COMMUNICATION_FAKE_PROVIDER=1 outside production and staging. Every accepted send is kept in
 * memory (without the address) so a test can assert exactly what would have been sent.
 */
export class FakeCommunicationProvider implements CommunicationProviderAdapter {
  readonly provider = 'FAKE' as const;
  readonly sent: Array<Omit<CommunicationSendRequest, 'recipientAddress'> & { addressDigest: string; providerMessageId: string }> = [];
  constructor(readonly channel: DeliverableChannel, private readonly environment: () => NodeJS.ProcessEnv = () => process.env) {}

  readiness() {
    return fakeProviderEnabled(this.environment()) ? 'READY' as const : 'CONFIGURATION_REQUIRED' as const;
  }

  async send(request: CommunicationSendRequest): Promise<CommunicationSendAccepted> {
    const providerMessageId = `fake-${request.deliveryId}-${request.attempt}`;
    this.sent.push({
      deliveryId: request.deliveryId, messageId: request.messageId, organizationId: request.organizationId, schoolId: request.schoolId,
      channel: request.channel, content: request.content, schoolName: request.schoolName, attempt: request.attempt, providerMessageId,
      addressDigest: createHash('sha256').update(request.recipientAddress).digest('hex').slice(0, 16),
    });
    return this.channel === 'EMAIL' ? { providerMessageId, sentAs: 'EMAIL' } : { providerMessageId, sentAs: 'SMS', segments: 1, encoding: 'GSM7' };
  }
}
