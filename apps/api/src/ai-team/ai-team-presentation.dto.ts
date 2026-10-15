import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import {
  HON_AI_TEAM_AVATAR_KEYS,
  HON_AI_TEAM_VOICE_PROFILES,
  type HonAiTeamAvatarKey,
  type HonAiTeamVoiceProfile,
} from '@hon/contracts';

/**
 * The global ValidationPipe forbids undeclared fields. This DTO deliberately
 * exposes no tool, authority, model, provider, role, payment, audit, or tenant
 * fields; all context comes from the guarded server boundary.
 */
export class UpdateAiTeamPresentationDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;

  @IsOptional()
  @IsIn(HON_AI_TEAM_AVATAR_KEYS)
  avatarKey?: HonAiTeamAvatarKey;

  @IsOptional()
  @IsIn(HON_AI_TEAM_VOICE_PROFILES)
  voiceProfile?: HonAiTeamVoiceProfile;
}
