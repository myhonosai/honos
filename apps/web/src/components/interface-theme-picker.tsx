'use client';

import React from 'react';
import { HON_INTERFACE_THEMES, type HonInterfaceTheme } from '@hon/design-system';

type InterfaceThemePickerProps = {
  current: HonInterfaceTheme;
  onChange: (theme: HonInterfaceTheme) => void;
  disabled?: boolean;
  busy?: boolean;
  ariaLabel?: string;
  presentation?: 'compact' | 'cards';
};

/** Shared presentation-only picker used by the HON shell and scoped onboarding surfaces. */
export function InterfaceThemePicker({
  current,
  onChange,
  disabled = false,
  busy = false,
  ariaLabel = 'Select HON interface theme',
  presentation = 'compact',
}: InterfaceThemePickerProps): React.ReactElement {
  return (
    <div className={`view-picker${presentation === 'cards' ? ' view-picker-cards' : ''}`} aria-label={ariaLabel} role="group" aria-busy={busy || undefined}>
      {HON_INTERFACE_THEMES.map((theme) => (
        <button
          key={theme.id}
          type="button"
          className={current === theme.id ? 'selected' : ''}
          aria-label={`Select ${theme.label}`}
          aria-pressed={current === theme.id}
          disabled={disabled}
          onClick={() => onChange(theme.id)}
        >
          <strong>{theme.label}</strong>
          <span>{theme.detail}</span>
          {presentation === 'cards' && <small>{theme.recommendedFor}</small>}
        </button>
      ))}
    </div>
  );
}
