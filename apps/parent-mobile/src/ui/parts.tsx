import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Text } from './text';
import { Icon } from './icons';
import { EDGE, radius, space, TOUCH, type, useColors } from './theme';

export function Card({ children, style, label }: { children: React.ReactNode; style?: ViewStyle; label?: string }) {
  const c = useColors();
  return <View accessible={!!label} accessibilityLabel={label} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, borderBottomColor: c.edge }, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" maxFontSizeMultiplier={1.6} style={{ color: c.text, fontSize: type.heading, fontWeight: '900' }}>{children}</Text>;
}
export function Section({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.title, fontWeight: '800', marginTop: space.xl, marginBottom: space.sm }}>{children}</Text>;
}
export function Body({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  const c = useColors();
  return <Text style={{ color: muted ? c.muted : c.text, fontSize: type.body, lineHeight: 22 }}>{children}</Text>;
}

/**
 * Chunky raised button: a coloured face on a darker edge that presses down when tapped.
 * primary = HON blue, go = lime (confirming steps such as booking), quiet = white with an outline.
 */
export function Button({ label, onPress, kind = 'primary', accessibilityLabel }: { label: string; onPress: () => void; kind?: 'primary' | 'go' | 'quiet'; accessibilityLabel?: string }) {
  const c = useColors();
  const [face, edge, fg] = kind === 'primary' ? [c.accent, c.accentEdge, c.accentText] : kind === 'go' ? [c.lime, c.limeEdge, c.limeText] : [c.surface, c.edge, c.accent];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: face, borderBottomColor: edge, borderColor: kind === 'quiet' ? c.edge : face,
        borderBottomWidth: pressed ? 2 : EDGE + 2, marginTop: pressed ? EDGE : 0 }]}>
      <Text maxFontSizeMultiplier={1.4} style={{ color: fg, fontSize: type.body, fontWeight: '800', letterSpacing: 0.4 }}>{label}</Text>
    </Pressable>
  );
}

/** Round raised back button used at the top of sub-screens. */
export function BackButton({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={({ pressed }) => [styles.back, { backgroundColor: c.surface, borderColor: c.edge, borderBottomWidth: pressed ? 2 : EDGE + 2, marginTop: pressed ? EDGE : 0 }]}>
      <Icon name="back" size={22} color={c.accent} />
    </Pressable>
  );
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const c = useColors();
  const [bg, fg] = tone === 'good' ? [c.successSoft, c.success] : tone === 'warn' ? [c.warningSoft, c.warning] : tone === 'bad' ? [c.dangerSoft, c.danger] : [c.surfaceAlt, c.muted];
  return <View style={[styles.pill, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: type.caption, fontWeight: '800' }}>{text}</Text></View>;
}

export function StateMessage({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <Card style={{ marginTop: space.xl }}>
      <Text accessibilityRole="header" style={{ fontSize: type.title, fontWeight: '800', color: useColors().text, marginBottom: space.sm }}>{title}</Text>
      <Body muted>{body}</Body>
      {action ? <View style={{ marginTop: space.lg }}><Button label={action.label} onPress={action.onPress} /></View> : null}
    </Card>
  );
}

export function Loading({ label }: { label: string }) {
  const c = useColors();
  return <View accessible accessibilityLabel={label} style={{ padding: space.xxl, alignItems: 'center' }}><ActivityIndicator color={c.accent} /></View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 2, borderBottomWidth: 2 + EDGE, padding: space.lg, marginBottom: space.md },
  button: { minHeight: TOUCH + 4, borderRadius: radius.md, borderWidth: 2, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center' },
  back: { width: TOUCH, height: TOUCH, borderRadius: radius.md, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
});
