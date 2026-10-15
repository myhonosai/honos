import {
  HON_AI_TEAM_AGENT_KEYS,
  type AiTeamAgentDefinition,
  type HonAiTeamAgentKey,
} from '@hon/contracts';

/**
 * Complete-tier directory definitions. This catalog is immutable application
 * metadata, not a registry for agents, principals, models, providers, tools, or
 * action authority. Tenant customization may alter only the resolved
 * presentation fields exposed by the AI Team API.
 */
export const AI_TEAM_CATALOG: readonly AiTeamAgentDefinition[] = [
  {
    agentKey: 'alex',
    defaultDisplayName: 'Alex',
    title: 'Operations guide',
    summary: 'A fixed HON directory profile for school operations guidance.',
    defaultAvatarKey: 'hon-agent-alex',
    defaultVoiceProfile: 'CLEAR',
  },
  {
    agentKey: 'chad',
    defaultDisplayName: 'Chad',
    title: 'Member experience guide',
    summary: 'A fixed HON directory profile for member experience guidance.',
    defaultAvatarKey: 'hon-agent-chad',
    defaultVoiceProfile: 'WARM',
  },
  {
    agentKey: 'maya',
    defaultDisplayName: 'Maya',
    title: 'Family support guide',
    summary: 'A fixed HON directory profile for family support guidance.',
    defaultAvatarKey: 'hon-agent-maya',
    defaultVoiceProfile: 'CALM',
  },
  {
    agentKey: 'marcus',
    defaultDisplayName: 'Marcus',
    title: 'Growth planning guide',
    summary: 'A fixed HON directory profile for growth planning guidance.',
    defaultAvatarKey: 'hon-agent-marcus',
    defaultVoiceProfile: 'ENERGETIC',
  },
  {
    agentKey: 'jordan',
    defaultDisplayName: 'Jordan',
    title: 'Staff coordination guide',
    summary: 'A fixed HON directory profile for staff coordination guidance.',
    defaultAvatarKey: 'hon-agent-jordan',
    defaultVoiceProfile: 'CLEAR',
  },
  {
    agentKey: 'claire',
    defaultDisplayName: 'Claire',
    title: 'Curriculum support guide',
    summary: 'A fixed HON directory profile for curriculum support guidance.',
    defaultAvatarKey: 'hon-agent-claire',
    defaultVoiceProfile: 'CALM',
  },
  {
    agentKey: 'lena',
    defaultDisplayName: 'Lena',
    title: 'Communications planning guide',
    summary: 'A fixed HON directory profile for communications planning guidance.',
    defaultAvatarKey: 'hon-agent-lena',
    defaultVoiceProfile: 'WARM',
  },
  {
    agentKey: 'eian',
    defaultDisplayName: 'Eian',
    title: 'Parent and student guide',
    summary: 'A fixed HON directory profile for parent and student guidance.',
    defaultAvatarKey: 'hon-agent-eian',
    defaultVoiceProfile: 'CLEAR',
  },
] as const;

const agentKeys = AI_TEAM_CATALOG.map((agent) => agent.agentKey);
if (new Set(agentKeys).size !== AI_TEAM_CATALOG.length
  || agentKeys.length !== HON_AI_TEAM_AGENT_KEYS.length
  || HON_AI_TEAM_AGENT_KEYS.some((agentKey) => !agentKeys.includes(agentKey))) {
  throw new Error('HON AI Team catalog must contain each approved agent key exactly once.');
}

export function aiTeamAgentDefinition(agentKey: HonAiTeamAgentKey): AiTeamAgentDefinition | undefined {
  return AI_TEAM_CATALOG.find((agent) => agent.agentKey === agentKey);
}
