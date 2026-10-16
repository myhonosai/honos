import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { HqPlatformOverview } from '@hon/contracts';
import { verifyHqPlatformOverview } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class HqOverviewService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private fail(error: unknown): never {
    if (error instanceof HttpException) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code === '42501') throw new ForbiddenException({ code: 'HQ_OVERVIEW_FORBIDDEN', detail: 'Current platform HQ overview access is not authorized.' });
    if (['22023', '22P02', '22007', '22008', '22003'].includes(code ?? '')) {
      throw new BadRequestException({ code: 'HQ_OVERVIEW_INVALID', detail: 'The HQ overview request could not be accepted.' });
    }
    // Do not expose database details, projection shape, private table names, or
    // whether a particular subject could be resolved.
    throw new ServiceUnavailableException({ code: 'HQ_OVERVIEW_UNAVAILABLE', detail: 'The HQ overview is unavailable. No result is shown.' });
  }

  /**
   * The service performs an application scope check, then the fixed database
   * function independently resolves the same verified subject in its own
   * read-only transaction. No caller input can select a tenant, role, time, or target.
   */
  async read(externalSubject: string): Promise<HqPlatformOverview> {
    try {
      const scope = await this.database.resolveHqOperatorScope(externalSubject, 'hq.dashboard.view');
      if (!scope || !['HON_HQ_OWNER', 'HON_HQ_OPERATOR'].includes(scope.hqRole)) {
        throw new ForbiddenException({ code: 'HQ_OVERVIEW_FORBIDDEN', detail: 'Current platform HQ overview access is not authorized.' });
      }
      return verifyHqPlatformOverview(await this.database.readHqPlatformOverview(externalSubject));
    } catch (error) {
      return this.fail(error);
    }
  }
}
