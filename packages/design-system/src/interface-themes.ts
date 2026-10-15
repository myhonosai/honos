export const HON_INTERFACE_THEMES = [
  {
    id: 'big-button',
    label: 'Big-Button / Phone',
    detail: 'Large touch targets and simple, mobile-first navigation',
    recommendedFor: 'families, newer staff, and on-the-go school operations',
  },
  {
    id: 'modern',
    label: 'Modern HON',
    detail: 'Balanced visual quality and operational clarity',
    recommendedFor: 'most schools and daily staff operations',
  },
  {
    id: 'classic',
    label: 'Classic / Agency Platform',
    detail: 'Higher-density CRM and administrative workspace',
    recommendedFor: 'experienced staff and power users',
  },
] as const;

export type HonInterfaceTheme = (typeof HON_INTERFACE_THEMES)[number]['id'];
export const DEFAULT_HON_INTERFACE_THEME: HonInterfaceTheme = 'modern';
