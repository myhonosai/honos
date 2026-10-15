import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ACTION_CATALOG, INCLUDED_AI_CREDITS, TIER_FEATURES } from '@hon/config';

@Controller('foundation')
export class FoundationController {
  @Get('status')
  status(): {
    persistence: 'configured';
    architecture: {
      tenancy: 'postgresql-rls';
      mutationPath: string;
      authorityModes: readonly string[];
    };
    tiers: typeof TIER_FEATURES;
    includedAiCredits: typeof INCLUDED_AI_CREDITS;
    actionCatalog: typeof ACTION_CATALOG;
  } {
    if (!process.env.HON_RUNTIME_DATABASE_URL) {
      throw new ServiceUnavailableException({
        type: 'https://hon.example/problems/persistence-not-configured',
        title: 'PostgreSQL persistence is not configured',
        status: 503,
        code: 'PERSISTENCE_NOT_CONFIGURED',
        detail: 'HON will not use its privileged migration connection to simulate tenant data or domain mutations.',
      });
    }

    return {
      persistence: 'configured',
      architecture: {
        tenancy: 'postgresql-rls',
        mutationPath: 'UI/AI/automation → typed command → authorization → policy → audit + outbox → domain service',
        authorityModes: ['AUTO', 'CONFIRM', 'RESTRICTED'],
      },
      tiers: TIER_FEATURES,
      includedAiCredits: INCLUDED_AI_CREDITS,
      actionCatalog: ACTION_CATALOG,
    };
  }
}
