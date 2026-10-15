export type AiUsageThreshold = 'NORMAL' | 'WARNING_75' | 'WARNING_90' | 'EXHAUSTED';

export function aiUsageThreshold(usedCredits: number, includedCredits: number): AiUsageThreshold {
  if (!Number.isFinite(usedCredits) || !Number.isFinite(includedCredits) || usedCredits < 0 || includedCredits <= 0) {
    throw new Error('AI_USAGE_INPUT_INVALID');
  }
  const ratio = usedCredits / includedCredits;
  if (ratio >= 1) return 'EXHAUSTED';
  if (ratio >= 0.9) return 'WARNING_90';
  if (ratio >= 0.75) return 'WARNING_75';
  return 'NORMAL';
}
