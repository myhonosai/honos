import { ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { HqSchoolDirectory } from '@hon/contracts';
import { verifyHqSchoolDirectory } from '@hon/domain';
import { RuntimeDatabaseService } from '../foundation/runtime-database.service.js';

@Injectable()
export class HqSchoolDirectoryService {
  constructor(private readonly database: RuntimeDatabaseService) {}

  private fail(error: unknown): never {
    if (error instanceof HttpException) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code === '42501') throw new ForbiddenException({ code: 'HQ_SCHOOLS_FORBIDDEN', detail: 'Current platform HQ school-directory access is not authorized.' });
    if (code === '28000' || code === '28P01') throw new UnauthorizedException({ code: 'HQ_SCHOOLS_UNAUTHENTICATED', detail: 'A verified platform HQ session is required.' });
    // Never disclose database details, source table names, account existence, or
    // whether a subject may have a current platform-operator grant.
    throw new ServiceUnavailableException({ code: 'HQ_SCHOOLS_UNAVAILABLE', detail: 'The HQ school directory is unavailable. No result is shown.' });
  }

  /**
   * The application scope check is deliberately repeated by the fixed database
   * function in its own read-only transaction. No caller can supply an account,
   * school, organization, authority, source, delegation, or time selector.
   */
  async read(externalSubject: string): Promise<HqSchoolDirectory> {
    try {
      const scope = await this.database.resolveHqOperatorScope(externalSubject, 'hq.dashboard.view');
      if (!scope || !['HON_HQ_OWNER', 'HON_HQ_OPERATOR'].includes(scope.hqRole)) {
        throw new ForbiddenException({ code: 'HQ_SCHOOLS_FORBIDDEN', detail: 'Current platform HQ school-directory access is not authorized.' });
      }
      return verifyHqSchoolDirectory(await this.database.readHqSchoolDirectory(externalSubject));
    } catch (error) {
      return this.fail(error);
    }
  }
}
