import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { FontsReadyProvider, fontFor, Text } from '../src/ui/text';
import { BackButton, Button } from '../src/ui/parts';
import { Icon, ICON_NAMES } from '../src/ui/icons';
import { palette } from '../src/ui/theme';

describe('Playful look (R1)', () => {
  it('maps every text weight to a bundled Nunito file', () => {
    expect(fontFor(undefined)).toBe('Nunito_400Regular');
    expect(fontFor('normal')).toBe('Nunito_400Regular');
    expect(fontFor('bold')).toBe('Nunito_800ExtraBold');
    expect(fontFor('600')).toBe('Nunito_700Bold');
    expect(fontFor('800')).toBe('Nunito_900Black');
    expect(fontFor('900')).toBe('Nunito_900Black');
  });

  it('uses the system font until Nunito has loaded', async () => {
    await render(<Text style={{ fontWeight: '800' }}>Hello</Text>);
    const style = StyleSheet.flatten(screen.getByText('Hello').props.style);
    expect(style.fontFamily).toBeUndefined();
    expect(style.fontWeight).toBe('800');
  });

  it('once loaded, swaps the weight for the matching font file (Android ignores fontWeight on custom fonts)', async () => {
    await render(<FontsReadyProvider value><Text style={[{ fontWeight: '700', color: 'red' }]}>Hello</Text></FontsReadyProvider>);
    const style = StyleSheet.flatten(screen.getByText('Hello').props.style);
    expect(style.fontFamily).toBe('Nunito_800ExtraBold');
    expect(style.fontWeight).toBeUndefined();
    expect(style.color).toBe('red');
  });

  it('keeps an explicit font family untouched', async () => {
    await render(<FontsReadyProvider value><Text style={{ fontFamily: 'Menlo' }}>Code</Text></FontsReadyProvider>);
    expect(StyleSheet.flatten(screen.getByText('Code').props.style).fontFamily).toBe('Menlo');
  });

  it('chunky buttons keep their label, role and press, in all three kinds', async () => {
    const pressed: string[] = [];
    await render(<>{(['primary', 'go', 'quiet'] as const).map(k => <Button key={k} kind={k} label={`Do ${k}`} onPress={() => pressed.push(k)} />)}</>);
    for (const k of ['primary', 'go', 'quiet']) await fireEvent.press(screen.getByRole('button', { name: `Do ${k}` }));
    expect(pressed).toEqual(['primary', 'go', 'quiet']);
  });

  it('the go button is lime with dark text so it reads clearly', async () => {
    await render(<Button kind="go" label="Book" onPress={() => undefined} />);
    expect(StyleSheet.flatten(screen.getByText('Book').props.style).color).toBe(palette.light.limeText);
  });

  it('back button is a labelled 48pt target', async () => {
    const back = jest.fn();
    await render(<BackButton label="Back to More" onPress={back} />);
    const button = screen.getByRole('button', { name: 'Back to More' });
    expect(StyleSheet.flatten(button.props.style).width).toBeGreaterThanOrEqual(48);
    await fireEvent.press(button);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('draws every icon, hidden from screen readers', async () => {
    await render(<>{ICON_NAMES.map(n => <Icon key={n} name={n} color="#000" />)}</>);
    for (const n of ICON_NAMES) expect(screen.getByTestId(`icon-${n}`, { includeHiddenElements: true })).toBeTruthy();
  });

  it('small text colours meet WCAG AA 4.5:1 on their backgrounds (light scheme)', () => {
    const l = palette.light;
    for (const [fg, bg] of [[l.success, l.successSoft], [l.warning, l.warningSoft], [l.danger, l.dangerSoft], [l.glowEdge, l.surface], [l.accentEdge, l.accentSoft], [l.accentEdge, l.surface], [l.muted, l.surface], [l.limeText, l.lime], [l.muted, l.coralSoft], [l.text, l.coralSoft]]) {
      expect(contrast(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('light and dark schemes define the same colours', () => {
    expect(Object.keys(palette.dark).sort()).toEqual(Object.keys(palette.light).sort());
  });
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); }
