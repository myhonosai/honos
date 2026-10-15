/** Human Migration Center registry, deliberately NOT an Action Engine catalog/tool. */
export const LEAD_IMPORT_COMMAND_REGISTRY = ['upload','read','review','finalize'].map(operation => ({
  code: `migration.lead_import.${operation}`, requiredPermission: `migration.lead_import.${operation}`,
  minimumTier: 'ESSENTIAL', sensitive: true, source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY',
})) as readonly { code: string; requiredPermission: string; minimumTier: 'ESSENTIAL'; sensitive: true; source: 'HUMAN_UI'; principalType: 'HUMAN_USER'; execution: 'HUMAN_ONLY' }[];
