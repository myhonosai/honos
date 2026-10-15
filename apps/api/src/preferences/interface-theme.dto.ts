import { IsIn, IsOptional } from 'class-validator';
import type { HonInterfaceTheme } from '@hon/contracts';

export class UpdateInterfaceThemeDto {
  @IsIn(['big-button', 'modern', 'classic'])
  interfaceTheme!: HonInterfaceTheme;

  @IsOptional()
  @IsIn(['ONBOARDING', 'SETTINGS'])
  selectedVia?: 'ONBOARDING' | 'SETTINGS';
}
