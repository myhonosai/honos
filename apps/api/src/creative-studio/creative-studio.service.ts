import { BadRequestException, ConflictException, HttpException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  CREATIVE_AVATAR_OPERATION, CREATIVE_PROVIDER_JOB_ID, validateCreativeProviderJobReceipt, CREATIVE_AVATAR_VIDEO_OPERATION, validateCreativeAvatarVideo, validateCreativeAvatarVideoInput,
  validateCreativeAvatarVideoReceipt, validateCreativeAvatarVideoRecords, type CreativeAvatarVideo, type CreativeAvatarVideoReceipt, type CreativeAvatarVideoRecords, CREATIVE_GENERATION_LIMITS, saasUuid, validateCreativeAvatar, validateCreativeAvatarInput,
  validateCreativeAvatarReceipt, validateCreativeAvatarRecords, validateCreativeGeneration, validateCreativeGenerationInput,
  validateCreativeGenerationReceipt, validateCreativeGenerationRecords, validateCreativeStudioAvatarList, validateCreativeStudioGenerationList,
  type CreativeAvatar, type CreativeAvatarReceipt, type CreativeGeneration, type CreativeGenerationReceipt, type CreativeStudioAvatarList,
  type CreativeStudioGenerationList,
} from '@hon/contracts';
import { SaasBillingService } from '../saas-billing/saas-billing.service.js';
import {
  CREATIVE_PROVIDER_RUNTIME, isAsyncCreativeProviderRuntime, type AsyncCreativeProviderRuntime, type CreativeAvatarLook, type CreativeInvocation,
  type CreativeProviderRoute, type CreativeProviderRuntime,
} from './creative-provider-runtime.js';
import { notSentOutcome, thrownOutcome, unknownOutcome as unknown, verifiedOutcome, type CreativeOutcome as Outcome } from './creative-outcome.js';
import { emitTelemetry } from '../observability/telemetry.js';

function parse<T>(work: () => T): T {
  try { return work(); } catch { throw new BadRequestException({ code: 'INVALID_SAAS_INPUT' }); }
}

/**
 * CS1 Creative Studio generation. Authority, the S4 pause and access decision, eligibility, rates, the per-school wallet
 * lock, idempotency and audit all live in the database (0202 + 0216); this service validates closed inputs and outputs,
 * makes the one provider call through the injected runtime and records its outcome exactly once. It never retries a
 * provider call, never charges the AI team and never touches the internal agent budget.
 */
@Injectable()
export class CreativeStudioService {
  constructor(
    private readonly billing: SaasBillingService,
    @Inject(CREATIVE_PROVIDER_RUNTIME) private readonly provider: CreativeProviderRuntime,
  ) {}

  private connected(): boolean { return this.provider.readiness() === 'READY'; }

  async list(subject: string, schoolId: unknown): Promise<CreativeStudioGenerationList> {
    const school = parse(() => saasUuid(schoolId));
    const records = await this.billing.call('readCreativeGenerations', [subject, school], validateCreativeGenerationRecords);
    try { return validateCreativeStudioGenerationList({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async read(subject: string, schoolId: unknown, generationId: unknown): Promise<CreativeGeneration> {
    const [school, generation] = parse(() => [saasUuid(schoolId), saasUuid(generationId)] as const);
    return this.billing.call('readCreativeGeneration', [subject, school, generation], validateCreativeGeneration);
  }

  /** Reserve -> one provider call -> record. The same key returns the same generation and never calls the provider again. */
  async create(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CreativeGenerationReceipt> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateCreativeGenerationInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(input.operationCode) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const created = await this.billing.call('createCreativeGeneration',
      [subject, school, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey, randomUUID(), randomUUID()],
      validateCreativeGenerationReceipt);
    const g = created.generation;
    if (created.replayed) return g.status === 'GENERATING' ? this.recoverInterrupted(subject, created) : created;
    if (g.status !== 'GENERATING') return created;
    return (await this.run(subject, g, route)) ?? created;
  }

  /** A replay of a request that never got an answer recorded: after the in-flight window the credits are held for HQ. */
  private async recoverInterrupted(subject: string, replay: CreativeGenerationReceipt): Promise<CreativeGenerationReceipt> {
    if (Date.now() - Date.parse(replay.generation.createdAt) < CREATIVE_GENERATION_LIMITS.interruptedAfterSeconds * 1000) return replay;
    try { return { ...(await this.record(subject, replay.generation.generationId, unknown('INTERRUPTED'))), replayed: true }; }
    catch (error) { if (error instanceof ConflictException) return replay; throw error; }
  }

  // ---------- A1 avatars (0276): one avatar = one generation of avatar.create, recorded by the same CS1 record ----------
  async listAvatars(subject: string, schoolId: unknown): Promise<CreativeStudioAvatarList> {
    const school = parse(() => saasUuid(schoolId));
    const records = await this.billing.call('readCreativeAvatars', [subject, school], validateCreativeAvatarRecords);
    try { return validateCreativeStudioAvatarList({ provider: this.connected() ? 'CONNECTED' : 'NOT_CONNECTED', ...records }); }
    catch { throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' }); }
  }

  async readAvatar(subject: string, schoolId: unknown, avatarId: unknown): Promise<CreativeAvatar> {
    const [school, avatar] = parse(() => [saasUuid(schoolId), saasUuid(avatarId)] as const);
    return this.billing.call('readCreativeAvatar', [subject, school, avatar], validateCreativeAvatar);
  }

  /** Create -> one provider call with the avatar's look -> record -> read the avatar back. Same key = same avatar, never a second call. */
  async createAvatar(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CreativeAvatarReceipt> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateCreativeAvatarInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(CREATIVE_AVATAR_OPERATION) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    const created = await this.billing.call('createCreativeAvatar',
      [subject, school, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey, randomUUID(), randomUUID()],
      validateCreativeAvatarReceipt);
    const g = created.avatar.generation;
    if (g.status !== 'GENERATING') return created;
    if (created.replayed) {
      const settled = await this.recoverInterrupted(subject, { generation: g, balance: created.balance, replayed: true });
      return settled.generation.status === 'GENERATING' ? created : this.avatarReceipt(subject, school, created.avatar.avatarId, settled, true);
    }
    const recorded = await this.run(subject, g, route, { name: input.name, style: input.style });
    return recorded ? this.avatarReceipt(subject, school, created.avatar.avatarId, recorded, false) : created;
  }

  // ---------- A2 avatar videos (0277): one video = one generation of avatar.video for a READY avatar ----------
  async listAvatarVideos(subject: string, schoolId: unknown): Promise<CreativeAvatarVideoRecords> {
    const school = parse(() => saasUuid(schoolId));
    return this.billing.call('readCreativeAvatarVideos', [subject, school], validateCreativeAvatarVideoRecords);
  }

  async readAvatarVideo(subject: string, schoolId: unknown, videoId: unknown): Promise<CreativeAvatarVideo> {
    const [school, video] = parse(() => [saasUuid(schoolId), saasUuid(videoId)] as const);
    return this.billing.call('readCreativeAvatarVideo', [subject, school, video], validateCreativeAvatarVideo);
  }

  /** Create -> one provider call with the avatar's look and the script -> record -> read the video back. Same key = same video. */
  async createAvatarVideo(subject: string, schoolId: unknown, body: unknown, key: unknown): Promise<CreativeAvatarVideoReceipt> {
    const [school, input, idempotencyKey] = parse(() => [saasUuid(schoolId), validateCreativeAvatarVideoInput(body), saasUuid(key)] as const);
    const route: CreativeProviderRoute | null = this.connected() ? this.provider.route(CREATIVE_AVATAR_VIDEO_OPERATION) : null;
    if (!route) throw new ServiceUnavailableException({ code: 'CREATIVE_PROVIDER_NOT_CONNECTED' });
    // The presenter's look, read under the requester's exact-school authority before anything is reserved (avatars are
    // immutable). The database create re-checks that the avatar is this school's and READY.
    const avatar = await this.billing.call('readCreativeAvatar', [subject, school, input.avatarId], validateCreativeAvatar);
    const created = await this.billing.call('createCreativeAvatarVideo',
      [subject, school, JSON.stringify(input), JSON.stringify({ providerId: route.providerId, modelCode: route.modelCode }), idempotencyKey, randomUUID(), randomUUID()],
      validateCreativeAvatarVideoReceipt);
    const g = created.video.generation;
    if (g.status !== 'GENERATING') return created;
    if (created.replayed) {
      const settled = await this.recoverInterrupted(subject, { generation: g, balance: created.balance, replayed: true });
      return settled.generation.status === 'GENERATING' ? created : this.videoReceipt(subject, school, created.video.videoId, settled, true);
    }
    const recorded = await this.run(subject, g, route, { name: avatar.name, style: avatar.style, description: avatar.description });
    return recorded ? this.videoReceipt(subject, school, created.video.videoId, recorded, false) : created;
  }

  private async videoReceipt(subject: string, school: string, videoId: string, recorded: CreativeGenerationReceipt, replayed: boolean): Promise<CreativeAvatarVideoReceipt> {
    const video = await this.billing.call('readCreativeAvatarVideo', [subject, school, videoId], validateCreativeAvatarVideo);
    return { video, balance: recorded.balance, replayed };
  }

  private async avatarReceipt(subject: string, school: string, avatarId: string, recorded: CreativeGenerationReceipt, replayed: boolean): Promise<CreativeAvatarReceipt> {
    const avatar = await this.billing.call('readCreativeAvatar', [subject, school, avatarId], validateCreativeAvatar);
    return { avatar, balance: recorded.balance, replayed };
  }

  private invocation(g: CreativeGeneration, route: CreativeProviderRoute, avatar?: CreativeAvatarLook): CreativeInvocation {
    return { ...route, providerRequestId: g.generationId, operationCode: g.operationCode, mediaKind: g.mediaKind, units: g.units, format: g.format,
      prompt: g.prompt, ...(avatar ? { avatar } : {}) };
  }

  /**
   * One provider attempt for a freshly reserved generation. Returns the recorded receipt, or null when an asynchronous
   * provider accepted the job and the worker will record its result (the generation stays GENERATING).
   */
  private async run(subject: string, g: CreativeGeneration, route: CreativeProviderRoute, avatar?: CreativeAvatarLook): Promise<CreativeGenerationReceipt | null> {
    const input = this.invocation(g, route, avatar);
    if (isAsyncCreativeProviderRuntime(this.provider)) return this.submit(subject, g, input, this.provider);
    let outcome: Outcome;
    try { outcome = verifiedOutcome(await this.provider.generate(input), g); } catch (error) { outcome = thrownOutcome(error); }
    return this.record(subject, g.generationId, outcome);
  }

  /**
   * C1 (0354): permit (the daily provider spend guard, decided again at the live clock) -> submit once -> record the
   * provider's job id. A refused permit records NOT_SENT (the credits come back) and answers with the refusal. Nothing is
   * ever resent: a replay of the same key returns the generation as it is.
   */
  private async submit(subject: string, g: CreativeGeneration, input: CreativeInvocation, provider: AsyncCreativeProviderRuntime): Promise<CreativeGenerationReceipt | null> {
    try {
      await this.billing.call('beginCreativeProviderSubmission', [subject, g.generationId], validateCreativeProviderJobReceipt);
    } catch (refusal) {
      // Nothing was sent. If the permit did commit and only its answer was lost, the job is PERMITTED and NOT_SENT closes it.
      try { await this.record(subject, g.generationId, notSentOutcome('PROVIDER_NOT_CONNECTED')); }
      catch { emitTelemetry('error', 'creative.permit_refusal_unrecorded', { component: 'creative-studio' }); }
      if (refusal instanceof HttpException) throw refusal;
      throw new ServiceUnavailableException({ code: 'SAAS_UNAVAILABLE' });
    }
    let providerJobId: string;
    try {
      const answer = await provider.submit(input);
      if (typeof answer?.providerJobId !== 'string' || !CREATIVE_PROVIDER_JOB_ID.test(answer.providerJobId)) return this.record(subject, g.generationId, unknown('UNVERIFIED_RESULT'));
      providerJobId = answer.providerJobId;
    } catch (error) { return this.record(subject, g.generationId, thrownOutcome(error)); }
    try {
      await this.billing.call('recordCreativeProviderSubmission', [subject, g.generationId, providerJobId], validateCreativeProviderJobReceipt);
    } catch {
      // The provider has the job but the id was not stored: the job stays PERMITTED and the deadline sweep records it
      // UNKNOWN for HQ after 30 minutes. It is never resent.
      emitTelemetry('error', 'creative.submission_unrecorded', { component: 'creative-studio' });
    }
    return null;
  }

  private record(subject: string, generationId: string, outcome: Outcome): Promise<CreativeGenerationReceipt> {
    return this.billing.call('recordCreativeGenerationResult', [subject, generationId, JSON.stringify(outcome)], validateCreativeGenerationReceipt);
  }
}
