/** Conventional human command metadata only; never an Action Engine tool or delivery adapter. */
export const CAMPAIGN_COMMAND_REGISTRY = ['create', 'update', 'status', 'attribute'].map(operation => ({
  code: `marketing.campaign.${operation}`, requiredPermission: `marketing.campaign.${operation}`,
  minimumTier: 'ESSENTIAL', source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY', planningOnly: true,
})) as readonly { code: string; requiredPermission: string; minimumTier: 'ESSENTIAL'; source: 'HUMAN_UI'; principalType: 'HUMAN_USER'; execution: 'HUMAN_ONLY'; planningOnly: true }[];
