import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  validateCreateSchoolWebsiteInput,
  validatePublishSchoolWebsiteInput,
  validateRollbackSchoolWebsiteInput,
  validateSaveSchoolWebsiteDraftInput,
  validateUnpublishSchoolWebsiteInput,
  verifyPublishedSchoolWebsite,
  verifySchoolWebsite,
  verifySchoolWebsiteRead,
  websiteSlugOk,
  type PublishedSchoolWebsite,
  type SchoolWebsite,
  type SchoolWebsiteRead,
} from '@hon/contracts';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';
import type { MembershipLifecycleContext } from '../billing/membership.service.js';

export type SchoolWebsiteContext = MembershipLifecycleContext;
export type SchoolWebsiteOperation = 'create' | 'save' | 'publish' | 'rollback' | 'unpublish';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const LIMITS = "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL log_parameter_max_length_on_error=0";
const VALIDATORS: Record<SchoolWebsiteOperation, (value: unknown) => object> = {
  create: validateCreateSchoolWebsiteInput,
  save: validateSaveSchoolWebsiteDraftInput,
  publish: validatePublishSchoolWebsiteInput,
  rollback: validateRollbackSchoolWebsiteInput,
  unpublish: validateUnpublishSchoolWebsiteInput,
};

const ERRORS: Record<string, (code: string) => HttpException> = {
  SCHOOL_WEBSITE_INVALID: code => new BadRequestException({ code, detail: 'The website does not fit the page and section rules. Reload it and try again.' }),
  SCHOOL_WEBSITE_REFERENCE_INVALID: code => new BadRequestException({ code, detail: 'A form, booking page or campaign on the site does not belong to this school.' }),
  SCHOOL_WEBSITE_REFERENCE_NOT_LIVE: code => new ConflictException({ code, detail: 'A form, booking page or campaign on the site is not live. Publish or reconnect it, then publish the site.' }),
  SCHOOL_WEBSITE_FORBIDDEN: code => new ForbiddenException({ code, detail: 'Live website permission at this school and an active subscription are required.' }),
  SCHOOL_WEBSITE_NOT_FOUND: code => new NotFoundException({ code }),
  SCHOOL_WEBSITE_EXISTS: code => new ConflictException({ code, detail: 'This school already has a website. Reload to edit it.' }),
  SCHOOL_WEBSITE_ADDRESS_TAKEN: code => new ConflictException({ code, detail: 'Another school already uses that web address. Choose a different one.' }),
  SCHOOL_WEBSITE_NOT_PUBLISHED: code => new ConflictException({ code, detail: 'The website is not published.' }),
  SCHOOL_WEBSITE_BUSY: code => new ConflictException({ code, detail: 'The same request is still being processed. Try again shortly with the same key.' }),
  VERSION_CONFLICT: code => new ConflictException({ code, detail: 'The website changed since you loaded it. Reload it and try again.' }),
  IDEMPOTENCY_KEY_REUSED: code => new ConflictException({ code, detail: 'The idempotency key was already used for a different request.' }),
};
function translate(error: unknown): never {
  if (error instanceof HttpException) throw error;
  const sqlState = (error as { code?: string })?.code ?? '';
  const message = (error as { message?: string })?.message ?? '';
  const known = ERRORS[message];
  if (known && ['22023', '42501', 'P0002', '40001', '23505', '55P03'].includes(sqlState)) throw known(message);
  if (sqlState === '42501') throw new ForbiddenException({ code: 'SCHOOL_WEBSITE_FORBIDDEN' });
  if (['40001', '40P01', '55P03', '23505'].includes(sqlState)) throw new ConflictException({ code: 'SCHOOL_WEBSITE_CONFLICT' });
  if (['22023', '22P02', '22003', '23514'].includes(sqlState)) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_INVALID' });
  throw new ServiceUnavailableException({ code: 'SCHOOL_WEBSITE_UNAVAILABLE', detail: 'No success is assumed. Reload, or retry the unchanged request with the same key.' });
}

/**
 * School websites (0361). Every call runs one protected definer function that re-proves the direct human subject and the
 * live website permission at the session school, before and after its writes. The runtime role has no table privilege.
 * Documents are validated closed here and again in the database; nothing here sends, publishes to a domain or calls AI.
 */
@Injectable()
export class SchoolWebsiteService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(context: SchoolWebsiteContext): Promise<SchoolWebsiteRead> {
    this.assertHuman(context, false);
    try {
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        return verifySchoolWebsiteRead((await client.query<{ data: unknown }>('SELECT hon.read_school_website($1) AS data', [context.externalSubject])).rows[0]?.data);
      });
    } catch (error) { return translate(error); }
  }

  async mutate(context: SchoolWebsiteContext, operation: SchoolWebsiteOperation, value: unknown): Promise<{ website: SchoolWebsite; replayed: boolean }> {
    this.assertHuman(context, true);
    const validator = VALIDATORS[operation];
    if (!validator) throw new BadRequestException({ code: 'SCHOOL_WEBSITE_INVALID' });
    let input: object;
    try { input = validator(value); } catch { throw new BadRequestException({ code: 'SCHOOL_WEBSITE_INVALID' }); }
    try {
      return await this.database.withTenantTransaction(context, async client => {
        await client.query(LIMITS);
        await client.query(HUMAN_SETTINGS, [context.externalSubject]);
        const result = await client.query<{ data: Record<string, unknown> }>('SELECT hon.mutate_school_website($1,$2,$3::jsonb,$4,$5::uuid,$6::uuid) AS data',
          [context.externalSubject, operation, JSON.stringify(input), context.idempotencyKey, context.requestId, context.correlationId]);
        const data = result.rows[0]?.data;
        if (result.rows.length !== 1 || !data || Object.keys(data).sort().join(',') !== 'replayed,website' || typeof data.replayed !== 'boolean') {
          throw new Error('Unverified website receipt.');
        }
        return { website: verifySchoolWebsite(data.website), replayed: data.replayed };
      });
    } catch (error) { return translate(error); }
  }

  /** Public read of a published site. null = no such live site; a failure never pretends the site is missing. */
  async published(slug: string): Promise<PublishedSchoolWebsite | null> {
    if (!websiteSlugOk(slug)) return null;
    try {
      const data = await this.database.readPublishedSchoolWebsite(slug);
      return data === null ? null : verifyPublishedSchoolWebsite(data, slug);
    } catch { throw new ServiceUnavailableException({ result: 'unavailable' }); }
  }

  private assertHuman(context: SchoolWebsiteContext, command: boolean): void {
    if (context.principalType !== 'HUMAN_USER' || context.source !== 'HUMAN_UI' || context.actionRequestId || context.delegatedByPrincipalId) {
      throw new ForbiddenException({ code: 'HUMAN_COMMAND_REQUIRED', detail: 'School websites accept only direct human commands.' });
    }
    const subject = context.externalSubject;
    if (typeof subject !== 'string' || !subject || subject.trim() !== subject || subject.length > 200) throw new ForbiddenException({ code: 'SCHOOL_WEBSITE_FORBIDDEN' });
    if (!command) {
      if (context.idempotencyKey !== '') throw new ConflictException({ code: 'IDEMPOTENCY_KEY_NOT_ACCEPTED' });
      return;
    }
    if (!context.idempotencyKey || context.idempotencyKey !== context.idempotencyKey.trim() || context.idempotencyKey.length > 200 || /[\u0000-\u001f\u007f]/.test(context.idempotencyKey)) {
      throw new ConflictException({ code: 'IDEMPOTENCY_KEY_REQUIRED', detail: 'A unique Idempotency-Key header is required.' });
    }
  }
}
