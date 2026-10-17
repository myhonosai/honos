import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/components/hon-reference-suite.tsx', 'utf8');
const styles = readFileSync('src/components/hon-reference-suite.module.css', 'utf8');
const dock = source.slice(source.indexOf('function AppearanceDock'), source.indexOf('function AgentPortrait'));

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe('HON reference appearance dock', () => {
  it('keeps the three presentation modes and three avatar choices visible with pressed selection semantics', () => {
    for (const label of ['Big-Button / Phone', 'Modern HON', 'Classic CRM', '3D Realistic', 'Modern Anime', 'Chibi']) {
      expect(source).toContain(label);
    }
    expect(dock).toContain('aria-pressed={theme === option.id}');
    expect(dock).toContain('aria-pressed={portraitStyle === option}');
    expect(dock).toContain('aria-label={`Select ${option.label} presentation mode`}');
    expect(dock).toContain('aria-label={`Select ${AI_PORTRAIT_STYLE_LABELS[option].label} avatar style`}');
    expect(occurrences(source, '<AppearanceDock')).toBeGreaterThanOrEqual(7);
  });

  it('uses one SSR-stable, allowlisted local-only reference preference state', () => {
    expect(source).toContain("const REFERENCE_THEME_STORAGE_KEY = 'hon.reference.appearance.theme.v1'");
    expect(source).toContain("const REFERENCE_AVATAR_STORAGE_KEY = 'hon.reference.appearance.avatar-style.v1'");
    expect(source).toContain('REFERENCE_THEME_OPTIONS.some((option) => option.id === value)');
    expect(source).toContain("Object.hasOwn(AI_PORTRAIT_STYLE_LABELS, value ?? '')");
    expect(source).toContain('if (value !== null && allowed === null) window.localStorage.removeItem(key)');
    expect(source).toContain("const [theme, setTheme] = useState<HonInterfaceTheme>('modern')");
    expect(source).toContain("const [portraitStyle, setPortraitStyle] = useState<AiPortraitStyle>('realistic')");
    expect(source).toContain('if (!appearanceHydrated) return');
    expect(occurrences(source, "useState<AiPortraitStyle>('realistic')")).toBe(1);
    expect(source).not.toContain('loadInterfaceThemePreference');
    expect(source).not.toContain('saveInterfaceThemePreference');
    expect(source).not.toMatch(/\bfetch\(/);
  });

  it('places the Modern Complete compact dock directly below the school selector as a closed inline details disclosure', () => {
    const completeReference = source.slice(source.indexOf('function CompleteReference'), source.indexOf('function HqReference'));
    const beforeDesktopShell = completeReference.slice(0, completeReference.indexOf('<div className={styles.desktopShell}>'));
    const schoolSelectIndex = completeReference.indexOf('styles.schoolSelect');
    const inlineDockIndex = completeReference.indexOf('variant="inline"');

    expect(source).toContain("type AppearanceDockVariant = 'full' | 'inline'");
    expect(dock).toContain('open={!isInline}');
    expect(dock).toContain('<summary className={styles.appearanceDockSummary}>');
    expect(completeReference).toContain('className={styles.schoolHeaderControls}');
    expect(schoolSelectIndex).toBeGreaterThan(-1);
    expect(inlineDockIndex).toBeGreaterThan(schoolSelectIndex);
    expect(beforeDesktopShell).not.toContain('<AppearanceDock');
    expect(dock).not.toContain('role="dialog"');
    expect(styles).toContain('.schoolHeaderControls{display:grid');
    expect(styles).toContain('.appearanceDock.appearanceDockInline{position:static');
    expect(styles).toContain('.appearanceDockInline .appearanceDockDetails:not([open]) .appearanceDockBody{display:none}');
    expect(styles).toContain('.appearanceDockInline .appearanceOptionGrid{grid-template-columns:1fr}');
    expect(styles).toContain('@media(max-width:820px){.schoolHeaderControls');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('keeps the dock strictly visual with no model, provider, tool grant, or authority-mode linkage', () => {
    expect(dock).toContain('Presentation only · visual styles never change agent identity, authority, routes, tools, data, actions, permissions, history, usage, or Action Engine authority.');
    expect(dock).not.toMatch(/(?:modelId|providerId|toolGrant|authorityMode|fetch\()/);
  });
});
