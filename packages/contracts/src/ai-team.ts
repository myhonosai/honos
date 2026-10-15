/**
 * The approved HON AI Team is a fixed product catalog. These identifiers are
 * not principal IDs, model IDs, tool grants, or authority assignments.
 */
export const HON_AI_TEAM_AGENT_KEYS = [
  'alex',
  'chad',
  'maya',
  'marcus',
  'jordan',
  'claire',
  'lena',
  'eian',
] as const;
export type HonAiTeamAgentKey = (typeof HON_AI_TEAM_AGENT_KEYS)[number];

/** Static application asset keys; callers may not supply URLs or arbitrary media. */
export const HON_AI_TEAM_AVATAR_KEYS = [
  'hon-agent-alex',
  'hon-agent-chad',
  'hon-agent-maya',
  'hon-agent-marcus',
  'hon-agent-jordan',
  'hon-agent-claire',
  'hon-agent-lena',
  'hon-agent-eian',
  'hon-agent-default',
] as const;
export type HonAiTeamAvatarKey = (typeof HON_AI_TEAM_AVATAR_KEYS)[number];

/** Provider-neutral presentation labels only; these select no provider or voice. */
export const HON_AI_TEAM_VOICE_PROFILES = [
  'CALM',
  'CLEAR',
  'WARM',
  'ENERGETIC',
] as const;
export type HonAiTeamVoiceProfile = (typeof HON_AI_TEAM_VOICE_PROFILES)[number];

/** Immutable product definition for one approved directory entry. */
export interface AiTeamAgentDefinition {
  agentKey: HonAiTeamAgentKey;
  defaultDisplayName: string;
  title: string;
  summary: string;
  defaultAvatarKey: HonAiTeamAvatarKey;
  defaultVoiceProfile: HonAiTeamVoiceProfile;
}

/**
 * Resolved presentation only. It has no authority, tool, model, provider,
 * payment, role, audit, or tenant-isolation controls.
 */
export interface AiTeamPresentation {
  displayName: string;
  avatarKey: HonAiTeamAvatarKey;
  voiceProfile: HonAiTeamVoiceProfile;
  /** Zero means this school has not persisted an override for this agent. */
  version: number;
  updatedAt?: string | undefined;
}

export interface AiTeamDirectoryAgent extends AiTeamAgentDefinition {
  presentation: AiTeamPresentation;
}

export interface AiTeamDirectory {
  agents: AiTeamDirectoryAgent[];
}

/** Only safe display options and an optimistic version may cross the API boundary. */
export interface UpdateAiTeamPresentationInput {
  expectedVersion: number;
  displayName?: string | undefined;
  avatarKey?: HonAiTeamAvatarKey | undefined;
  voiceProfile?: HonAiTeamVoiceProfile | undefined;
}
