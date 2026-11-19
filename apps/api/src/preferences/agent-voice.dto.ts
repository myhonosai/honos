import { IsIn } from 'class-validator';
import { HON_AGENT_VOICE_CHOICES, HON_VOICE_AGENT_KEYS, type HonAgentVoiceChoice, type HonVoiceAgentKey } from '@hon/contracts';

/** One teammate's voice choice. Presentation only: 1, 2 or 3 maps to a free browser voice in the web app. */
export class UpdateAgentVoiceDto {
  @IsIn([...HON_VOICE_AGENT_KEYS])
  agentKey!: HonVoiceAgentKey;

  @IsIn([...HON_AGENT_VOICE_CHOICES])
  voiceChoice!: HonAgentVoiceChoice;
}
