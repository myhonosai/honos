export function createFamilyReadAccounting(origin: string, scope: { organizationId: string; schoolId: string }): {
  observe(method: string, url: string): void;
  snapshot(): { familyGets: string[]; languageGets: number; identityGets: number; unexpectedGets: Array<{ path: string; sameOrigin: boolean; hasQuery: boolean; hasFragment: boolean }> };
  assertAllowedGets(stage: string): void;
  assertDomainReads(expected: number, stage: string): void;
};
