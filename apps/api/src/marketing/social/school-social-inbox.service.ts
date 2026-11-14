import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  SOCIAL_INBOX_VIEWS, validateSocialCommentActionInput, validateSocialConversationChangeInput, validateSocialMessageResolveInput, validateSocialReplyInput,
  verifySocialCommentActionResult, verifySocialConversation, verifySocialConversationDetail, verifySocialInboxList, verifySocialMessage, verifySocialReplyResult,
  type SocialCommentActionResult, type SocialConversation, type SocialConversationDetail, type SocialInboxList, type SocialMessage, type SocialReplyResult,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../../foundation/runtime-database.service.js';
import { SOCIAL_HUMAN_SETTINGS, SOCIAL_LIMITS, translateSocialError, type SchoolSocialContext, type SocialErrorTable } from './school-social.service.js';
import { SocialProviderError, ZERNIO_SOCIAL_ADAPTER, type ZernioSocialAdapter } from './zernio-social-adapter.js';

const INBOX_ERRORS: SocialErrorTable = {
  SOCIAL_FORBIDDEN: [['42501'], code => new ForbiddenException({ code, detail: 'Social inbox permission at this school is required.' })],
  SOCIAL_CONVERSATION_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_MESSAGE_NOT_FOUND: [['P0002'], code => new NotFoundException({ code })],
  SOCIAL_LINK_NOT_FOUND: [['P0002'], code => new HttpException({ code, detail: 'That lead or person is not at this school.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
  SOCIAL_ASSIGNEE_INVALID: [['22023'], code => new HttpException({ code, detail: 'Choose a staff member who works at this school.' }, HttpStatus.UNPROCESSABLE_ENTITY)],
  SOCIAL_INBOX_OFF: [['23514'], code => new ConflictException({ code, detail: 'The inbox is turned off for this account. Turn it on in Social accounts first.' })],
  SOCIAL_REPLY_WINDOW_CLOSED: [['55000'], code => new ConflictException({ code, detail: 'Messenger and Instagram allow a reply only within 24 hours of the person\'s last message.' })],
  SOCIAL_INBOX_STATE: [['55000'], code => new ConflictException({ code, detail: 'This already moved on. Reload to see where it is.' })],
  SOCIAL_VERSION_CONFLICT: [['40001'], code => new ConflictException({ code, detail: 'Someone changed this conversation. Reload and try again.' })],
};

function notEnabled(): never {
  throw new ServiceUnavailableException({ code: 'SOCIAL_INBOX_NOT_ENABLED', detail: 'Replying from HON is not turned on yet. Nothing was sent.' });
}
function receipt(): never { throw new Error('Unverified social inbox receipt.'); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[0-9A-Za-z_:.-]{1,128}$/;

type Data = Record<string, unknown>;
interface ReplySend { messageId: string; leaseToken: string; platform: 'FACEBOOK' | 'INSTAGRAM'; kind: 'DM' | 'COMMENT'; providerAccountId: string; providerConversationId: string }
interface CommentSend { actionId: string; leaseToken: string; platform: 'FACEBOOK' | 'INSTAGRAM'; providerAccountId: string; providerCommentId: string; hidden: boolean }

/**
 * School social inbox (0349). Every database call is one protected definer function that re-proves the direct human
 * at the session school. A reply or comment action is recorded first (SENDING under a 60-second lease), Zernio is
 * called once between transactions with the record id as idempotency key, and the answer is recorded under that
 * lease. A lost answer is UNKNOWN and never resent; a person settles it.
 */
@Injectable()
export class SchoolSocialInboxService {
  constructor(private readonly database: RuntimeDatabaseService, @Inject(ZERNIO_SOCIAL_ADAPTER) private readonly adapter: ZernioSocialAdapter) {}

  async list(context: SchoolSocialContext, query: Record<string, unknown>): Promise<SocialInboxList> {
    this.assertHuman(context, false);
    const keys = Object.keys(query);
    if (keys.some(k => k !== 'view' && k !== 'before')) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const view = query.view ?? 'ALL';
    if (typeof view !== 'string' || !(SOCIAL_INBOX_VIEWS as readonly string[]).includes(view)) throw new BadRequestException({ code: 'SOCIAL_INVALID' });
    const filter: Data = { view };
    if (query.before !== undefined) {
      if (typeof query.before !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(query.before) || Number.isNaN(Date.parse(query.before))) {
        throw new BadRequestException({ code: 'SOCIAL_INVALID' });
      }
      filter.before = query.before;
    }
    const data = await this.run(context, true, client => client.query<{ data: Data }>('SELECT hon.read_school_social_inbox($1,$2::jsonb) AS data',
      [context.externalSubject, JSON.stringify(filter)]));
    return verifySocialInboxList({ ...data, inboxEnabled: this.adapter.inboxReady() });
  }

  async conversation(context: SchoolSocialContext, conversationId: string): Promise<SocialConversationDetail> {
    this.assertHuman(context, false);
    const data = await this.run(context, true, client => client.query<{ data: Data }>('SELECT hon.read_school_social_conversation($1,$2::uuid) AS data',
      [context.externalSubject, conversationId]));
    const detail = verifySocialConversationDetail({ ...data, inboxEnabled: this.adapter.inboxReady() });
    if (detail.conversation.conversationId !== conversationId.toLowerCase()) receipt();
    return detail;
  }

  async change(context: SchoolSocialContext, conversationId: string, value: unknown): Promise<{ conversation: SocialConversation; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialConversationChangeInput, value);
    const { record, replayed } = this.command(await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.change_school_social_conversation($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', this.args(context, conversationId, input))));
    const conversation = verifySocialConversation(record);
    if (conversation.conversationId !== conversationId.toLowerCase()) receipt();
    return { conversation, replayed };
  }

  async reply(context: SchoolSocialContext, conversationId: string, value: unknown): Promise<{ reply: SocialReplyResult; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialReplyInput, value);
    if (!this.adapter.inboxReady()) notEnabled();
    const started = await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.start_school_social_reply($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', this.args(context, conversationId, input)));
    const { record, replayed } = this.command(started, true);
    const reply = verifySocialReplyResult(record);
    if (reply.conversation.conversationId !== conversationId.toLowerCase()) receipt();
    if (replayed) return { reply, replayed };
    const send = this.replySend(started.send, reply);
    let outcome: 'SENT' | 'FAILED' | 'UNKNOWN', providerMessageId: string | null = null;
    try {
      ({ providerMessageId } = await this.adapter.sendReply({ providerAccountId: send.providerAccountId, platform: send.platform, kind: send.kind,
        providerConversationId: send.providerConversationId, text: input.text, idempotencyKey: send.messageId }));
      outcome = PROVIDER_ID.test(providerMessageId) ? 'SENT' : 'UNKNOWN';
      if (outcome === 'UNKNOWN') providerMessageId = null;
    } catch (error) { outcome = this.failure(error); }
    const message = await this.recordReply(context, send, reply.message, outcome, providerMessageId);
    return { reply: { conversation: reply.conversation, message }, replayed: false };
  }

  async resolve(context: SchoolSocialContext, messageId: string, value: unknown): Promise<{ message: SocialMessage; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialMessageResolveInput, value);
    const { record, replayed } = this.command(await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.resolve_school_social_message($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', this.args(context, messageId, input))));
    const message = verifySocialMessage(record);
    if (message.messageId !== messageId.toLowerCase() || message.direction !== 'OUTBOUND') receipt();
    return { message, replayed };
  }

  async comment(context: SchoolSocialContext, conversationId: string, value: unknown): Promise<{ result: SocialCommentActionResult; replayed: boolean }> {
    this.assertHuman(context, true);
    const input = this.validate(validateSocialCommentActionInput, value);
    if (!this.adapter.inboxReady()) notEnabled();
    const started = await this.run(context, false, client => client.query<{ data: Data }>(
      'SELECT hon.start_school_social_comment_action($1,$2::uuid,$3::jsonb,$4,$5::uuid,$6::uuid) AS data', this.args(context, conversationId, input)));
    const { record, replayed } = this.command(started, true);
    const result = verifySocialCommentActionResult(record);
    if (result.conversation.conversationId !== conversationId.toLowerCase() || result.action !== input.action) receipt();
    if (replayed) return { result, replayed };
    const send = this.commentSend(started.send, result);
    let outcome: 'DONE' | 'FAILED' | 'UNKNOWN';
    try {
      await this.adapter.setCommentHidden({ providerAccountId: send.providerAccountId, providerCommentId: send.providerCommentId, hidden: send.hidden, idempotencyKey: send.actionId });
      outcome = 'DONE';
    } catch (error) { outcome = this.failure(error); }
    let recorded: Data;
    try {
      recorded = await this.run(context, false, client => client.query<{ data: Data }>(
        'SELECT hon.record_school_social_comment_action_result($1,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid) AS data',
        [context.externalSubject, send.actionId, send.leaseToken, outcome, context.requestId, context.correlationId]));
    } catch {
      // The provider may have acted; the lease runs out and the action reads as UNKNOWN. Never retried from here.
      return { result: { ...result, status: 'UNKNOWN' }, replayed: false };
    }
    if (typeof recorded.accepted !== 'boolean') receipt();
    const { accepted: _accepted, ...rest } = recorded;
    const final = verifySocialCommentActionResult(rest);
    if (final.actionId !== send.actionId) receipt();
    return { result: final, replayed: false };
  }

  /** Records the reply answer under its own lease. If recording fails the answer is UNKNOWN: the lease runs out. */
  private async recordReply(context: SchoolSocialContext, send: ReplySend, started: SocialMessage, outcome: 'SENT' | 'FAILED' | 'UNKNOWN', providerMessageId: string | null): Promise<SocialMessage> {
    let data: Data;
    try {
      data = await this.run(context, false, client => client.query<{ data: Data }>(
        'SELECT hon.record_school_social_reply_result($1,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid) AS data',
        [context.externalSubject, send.messageId, send.leaseToken, outcome, outcome === 'SENT' ? providerMessageId : null, context.requestId, context.correlationId]));
    } catch {
      // The platform may have the reply; HON does not know, so it reads as UNKNOWN and is never resent from here.
      return { ...started, status: 'UNKNOWN' };
    }
    if (Object.keys(data).sort().join(',') !== 'accepted,message' || typeof data.accepted !== 'boolean') receipt();
    const message = verifySocialMessage(data.message);
    if (message.messageId !== send.messageId || message.direction !== 'OUTBOUND') receipt();
    return message;
  }

  /** A definite refusal (nothing sent) is FAILED; anything else that may have reached the platform is UNKNOWN. */
  private failure(error: unknown): 'FAILED' | 'UNKNOWN' {
    if (error instanceof SocialProviderError && ['REJECTED', 'RATE_LIMITED', 'NOT_ENABLED'].includes(error.failure)) return 'FAILED';
    return 'UNKNOWN';
  }

  private replySend(value: unknown, reply: SocialReplyResult): ReplySend {
    const s = value as ReplySend | undefined;
    if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'kind,leaseToken,messageId,platform,providerAccountId,providerConversationId'
      || !UUID.test(s.messageId) || !UUID.test(s.leaseToken) || s.messageId.toLowerCase() !== reply.message.messageId || s.kind !== reply.conversation.kind
      || s.platform !== reply.conversation.platform || typeof s.providerAccountId !== 'string' || typeof s.providerConversationId !== 'string') receipt();
    return s;
  }

  private commentSend(value: unknown, result: SocialCommentActionResult): CommentSend {
    const s = value as CommentSend | undefined;
    if (!s || typeof s !== 'object' || Object.keys(s).sort().join(',') !== 'actionId,hidden,leaseToken,platform,providerAccountId,providerCommentId'
      || !UUID.test(s.actionId) || !UUID.test(s.leaseToken) || s.actionId.toLowerCase() !== result.actionId || s.hidden !== (result.action === 'HIDE')
      || s.platform !== result.conversation.platform || typeof s.providerAccountId !== 'string' || typeof s.providerCommentId !== 'string') receipt();
    return s;
  }

  private validate<T>(validator: (value: unknown) => T, value: unknown): T {
    try { return validator(value); } catch { throw new BadRequestException({ code: 'SOCIAL_INVALID' }); }
  }

  private args(context: SchoolSocialContext, id: string, input: object): unknown[] {
    return [context.externalSubject, id, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId];
  }

  /** A command receipt is {record, replayed} and, for a first reply or comment action, {send}. */
  private command(data: Data, sends = false): { record: unknown; replayed: boolean } {
    const keys = Object.keys(data).sort().join(',');
    if (typeof data.replayed !== 'boolean') receipt();
    const want = sends && !data.replayed ? 'record,replayed,send' : 'record,replayed';
    if (keys !== want) receipt();
    return { record: data.record, replayed: data.replayed };
  }

  private async run(context: SchoolSocialContext, readOnly: boolean, call: (client: PoolClient) => Promise<{ rows: { data: Data }[] }>): Promise<Data> {
    try {
      const body = async (client: PoolClient) => {
        await client.query(SOCIAL_LIMITS); await client.query(SOCIAL_HUMAN_SETTINGS, [context.externalSubject]);
        const r = await call(client);
        if (r.rows.length !== 1 || !r.rows[0]?.data || typeof r.rows[0].data !== 'object') receipt();
        return r.rows[0].data;
      };
      return readOnly ? await this.database.withTenantReadOnlyTransaction(context, body) : await this.database.withTenantTransaction(context, body);
    } catch (error) { return translateSocialError(error, INBOX_ERRORS); }
  }

  private assertHuman(context: SchoolSocialContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || !context.externalSubject
      || (command ? !context.idempotencyKey || context.idempotencyKey.length > 200 : context.idempotencyKey !== '')) throw new ForbiddenException({ code: 'SOCIAL_FORBIDDEN' });
  }
}
