/** Conventional human read; NOT a command, Tool Gateway adapter or executable action. */
export const STAFF_SEARCH_READ_REGISTRY = {
  code: 'search.global', requiredPermission: 'search.global', minimumTier: 'ESSENTIAL',
  principalType: 'HUMAN_USER', operation: 'READ_ONLY', maximumResults: 20,
} as const;
