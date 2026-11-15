import {
  CreativeProviderRuntimeError, UnconfiguredCreativeProviderRuntime, type AsyncCreativeProviderRuntime, type CreativeInvocation, type CreativePollResult,
  type CreativeProviderJob, type CreativeProviderRoute, type CreativeProviderRuntime, type CreativeResult, type CreativeSubmission,
} from '../creative-provider-runtime.js';
import { HeyGenCreativeRuntime } from './heygen-runtime.js';
import { HiggsfieldCreativeRuntime } from './higgsfield-runtime.js';

/**
 * One runtime over the real adapters (C2). The server picks the provider per operation (design doc §2.3); each submit and
 * poll goes only to the adapter named on the job. READY when at least one adapter can take new work.
 */
export class CreativeProviderRouter implements AsyncCreativeProviderRuntime {
  constructor(private readonly adapters: Readonly<Record<string, AsyncCreativeProviderRuntime>>) {}
  readiness(): 'READY' | 'CONFIGURATION_REQUIRED' {
    return Object.values(this.adapters).some(a => a.readiness() === 'READY') ? 'READY' : 'CONFIGURATION_REQUIRED';
  }
  route(operationCode: string): CreativeProviderRoute | null {
    for (const [providerId, adapter] of Object.entries(this.adapters)) {
      const route = adapter.route(operationCode);
      if (route && route.providerId === providerId) return route;
    }
    return null;
  }
  async generate(): Promise<CreativeResult> { throw new CreativeProviderRuntimeError('PRE_SEND', 'INVALID_REQUEST'); }
  async submit(input: CreativeInvocation): Promise<CreativeSubmission> {
    const adapter = Object.hasOwn(this.adapters, input.providerId) ? this.adapters[input.providerId] : undefined;
    if (!adapter) throw new CreativeProviderRuntimeError('PRE_SEND', 'CONFIGURATION_REQUIRED');
    return adapter.submit(input);
  }
  async poll(job: CreativeProviderJob): Promise<CreativePollResult> {
    const adapter = Object.hasOwn(this.adapters, job.providerId) ? this.adapters[job.providerId] : undefined;
    if (!adapter) throw new Error('creative provider not available');
    return adapter.poll(job);
  }
}

/**
 * Production wiring. Real providers are used only when HON can copy their results into its own storage (C3); until then
 * this always answers with the unconfigured runtime (NOT_CONNECTED), whatever keys or switches are set. With storage, a
 * provider is still READY only with its key(s) present and its switch exactly "true" (HON_CREATIVE_HIGGSFIELD_APPROVED,
 * HON_CREATIVE_HEYGEN_APPROVED), and the database still decides the program, wallet, pause and daily limits.
 */
export function createCreativeProviderRuntime(options: { mediaStorageReady: boolean; environment?: () => NodeJS.ProcessEnv }): CreativeProviderRuntime {
  if (options.mediaStorageReady !== true) return new UnconfiguredCreativeProviderRuntime();
  const environment = options.environment ?? (() => process.env);
  return new CreativeProviderRouter({ HIGGSFIELD: new HiggsfieldCreativeRuntime(environment), HEYGEN: new HeyGenCreativeRuntime(environment) });
}
