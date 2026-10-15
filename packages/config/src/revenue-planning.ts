/** Inert conventional metadata: deliberately not registered as an Action Engine tool. */
export const REVENUE_PLANNING_COMMAND_REGISTRY = ['create','update'].map(operation => ({
  code: `planning.revenue.${operation}`, requiredPermission: 'planning.revenue.manage',
  minimumTier: 'ESSENTIAL', source: 'HUMAN_UI', principalType: 'HUMAN_USER', execution: 'HUMAN_ONLY',
})) as readonly {code:string;requiredPermission:'planning.revenue.manage';minimumTier:'ESSENTIAL';source:'HUMAN_UI';principalType:'HUMAN_USER';execution:'HUMAN_ONLY'}[];
