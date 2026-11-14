import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  SOCIAL_POST_RANGE_DAYS, validateSocialPostApproveInput, validateSocialPostCancelInput, validateSocialPostDraftInput, validateSocialPostEditInput,
  validateSocialPostResolveInput, verifySocialPost, verifySocialPostList, type SocialPost, type SocialPostList,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SOCIAL_HUMAN_SETTINGS, SOCIAL_LIMITS, translateSocialError, type SchoolSocialContext, type SocialErrorTable } from './school-social.service.js';
import { ZERNIO_SOCIAL_ADAPTER, type ZernioSocialAdapter } from './zernio-social-adapter.js';

const POST_ERRORS: SocialErrorTable = {
  SOCIAL_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Social posting permission at this school is required.' })],
  SOCIAL_MEDIA_REQUIRED: [['0A000'], code => new HttpException({ code, detail: 'Instagram posts need a photo or video, which HON cannot attach yet. Choose a Facebook Page.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
  SOCIAL_POST_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_POST_STATE: [['55000'], code => new ConflictException({ code, detail: 'This post already moved on. Reload to see where it is.' })],
  SOCIAL_PUBLISH_OFF: [['23514'], code => new ConflictException({ code, detail: 'Publishing is turned off for one of these accounts. Turn it on in Social accounts first.' })],
  SOCIAL_VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this post. Reload and try again.' })],
};

type Mutation = 'create' | 'edit' | 'approve' | 'cancel' | 'resolve';
const CALLS: Record<Mutation, string> = {
  create: 'SELECT hon.create_school_social_post($1,$2::jsonb,$3,$4::uuid,$5::uuid) AS data',
  edit: 'SELECT hon.edit_school_social_post($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
  approve: 'SELECT hon.approve_school_social_post($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
  cancel: 'SELECT hon.cancel_school_social_post($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
  resolve: 'SELECT hon.resolve_school_social_post_target($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
};
const VALIDATE: Record<Mutation, (value: unknown) => object> = {
  create: validateSocialPostDraftInput, edit: validateSocialPostEditInput, approve: validateSocialPostApproveInput,
  cancel: validateSocialPostCancelInput, resolve: validateSocialPostResolveInput,
};

/**
 * School posts (0348). Every call is one protected definer function that re-proves the direct human at the session
 * school; nothing here calls Zernio. Publishing happens only in the worker, and only when publishing is READY.
 */
@Injectable()
export class SchoolSocialPostsService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(ZERNIO_SOCIAL_ADAPTER) private readonly adapter: ZernioSocialAdapter) {}

  async list(context: SchoolSocialContext, query: Record<string, unknown>): Promise<SocialPostList> {
    this.assertHuman(context, false);
    const keys = Object.keys(query).sort().join(',');
    const from = typeof query.from === 'string' ? Date.parse(query.from) : NaN, to = typeof query.to === 'string' ? Date.parse(query.to) : NaN;
    if (keys !== 'from,to' || !/^\d{4}-\d{2}-\d{2}T/.test(String(query.from)) || !/^\d{4}-\d{2}-\d{2}T/.test(String(query.to))
      || Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > SOCIAL_POST_RANGE_DAYS * 86_400_000) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const data = await this.run(context, true, client => client.query<{ data: Record<string, unknown> }>(
      'SELECT hon.read_school_social_posts($1,$2::timestamptz,$3::timestamptz) AS data', [context.externalSubject, new Date(from).toISOString(), new Date(to).toISOString()]));
    return verifySocialPostList({ ...data, publishEnabled: this.adapter.publishReady() });
  }

  /** create takes no id; edit/approve/cancel take the post id; resolve takes the target id. */
  async mutate(context: SchoolSocialContext, action: Mutation, id: string | null, value: unknown): Promise<{ post: SocialPost; replayed: boolean }> {
    this.assertHuman(context, true);
    if ((action === 'create') !== (id === null)) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    let input: object;
    try { input = VALIDATE[action](value); } catch { throw new BadRequestException({ code: 'SOCIAL_INVALID' }); }
    const args = action === 'create'
      ? [context.externalSubject, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]
      : [context.externalSubject, id, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId];
    const data = await this.run(context, false, client => client.query<{ data: Record<string, unknown> }>(CALLS[action], args));
    if (Object.keys(data).sort().join(',') !== 'record,replayed' || typeof data.replayed !== 'boolean') throw new Error('Unverified social post receipt.');
    const post = verifySocialPost(data.record);
    if ((action === 'edit' || action === 'approve' || action === 'cancel') && post.postId.toLowerCase() !== id!.toLowerCase()) throw new Error('Unverified social post receipt.');
    if (action === 'resolve' && !post.targets.some(t => t.targetId.toLowerCase() === id!.toLowerCase())) throw new Error('Unverified social post receipt.');
    return { post, replayed: data.replayed };
  }

  private async run(context: SchoolSocialContext, readOnly: boolean,
    call: (client: PoolClient) => Promise<{ rows: { data: Record<string, unknown> }[] }>): Promise<Record<string, unknown>> {
    try {
      const body = async (client: PoolClient) => {
        await client.query(SOCIAL_LIMITS); await client.query(SOCIAL_HUMAN_SETTINGS, [context.externalSubject]);
        const r = await call(client);
        if (r.rows.length !== 1 || !r.rows[0]?.data || typeof r.rows[0].data !== 'object') throw new Error('Unverified social post receipt.');
        return r.rows[0].data;
      };
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, body) : await this.database.withTenantTransaction(context, body);
    } catch (error) { return translateSocialError(error, POST_ERRORS); }
  }

  private assertHuman(context: SchoolSocialContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
  }
}
