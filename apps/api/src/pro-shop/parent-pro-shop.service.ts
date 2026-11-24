import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { verifyParentProShop, type ParentProShop } from '@hon/contracts';
import { RuntimeDatabaseService, type ResolvedParentFamilyScope } from '../foundation/runtime-database.service.js';

const HUMAN_SETTINGS = "SELECT set_config('app.hon_source','HUMAN_UI',true),set_config('app.hon_external_subject',$1,true),set_config('app.hon_action_request_id','',true),set_config('app.hon_delegated_by_principal_id','',true)";
const READ_LIMITS = "SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='3s'; SET LOCAL log_parameter_max_length_on_error=0";

export function translateParentProShopError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if ((error as { code?: string })?.code === '42501') throw new ForbiddenException({ code: 'PARENT_PRO_SHOP_FORBIDDEN' });
  throw new ServiceUnavailableException({ code: 'PARENT_PRO_SHOP_UNAVAILABLE', detail: 'No verified pro shop answer is available.' });
}

/**
 * 0581 parent pro shop. The one live family grant decides the school, with no selector trusted. The read returns the school's
 * mirrored Shopify products with links to the school's own store; HON takes no order or payment.
 */
@Injectable()
export class ParentProShopService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  async read(subject: string): Promise<ParentProShop> {
    if (typeof subject !== 'string' || !subject || subject.length > 200 || subject.trim() !== subject) throw new ForbiddenException({ code: 'PARENT_PRO_SHOP_FORBIDDEN' });
    try {
      const scopes: ResolvedParentFamilyScope[] = await this.database.resolveParentJourneyScopes(subject);
      if (scopes.length !== 1) throw new ForbiddenException({ code: 'PARENT_PRO_SHOP_FORBIDDEN' });
      const scope = scopes[0]!;
      const context = { organizationId: scope.organizationId, schoolId: scope.schoolId, principalId: scope.principalId, principalType: 'HUMAN_USER', requestId: randomUUID() };
      return await this.database.withTenantReadOnlyTransaction(context, async client => {
        await client.query(READ_LIMITS);
        await client.query(HUMAN_SETTINGS, [subject]);
        const result = await client.query<{ data: unknown }>('SELECT hon.read_parent_pro_shop($1) AS data', [subject]);
        if (result.rows.length !== 1) throw new Error('Unverified pro shop read.');
        return verifyParentProShop(result.rows[0]!.data);
      });
    } catch (error) { return translateParentProShopError(error); }
  }
}
