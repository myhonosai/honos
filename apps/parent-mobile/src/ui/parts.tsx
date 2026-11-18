import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { radius, space, TOUCH, type, useColors } from './theme';

export function Card({ children, style, label }: { children: React.ReactNode; style?: ViewStyle; label?: string }) {
  const c = useColors();
  return <View accessible={!!label} accessibilityLabel={label} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" maxFontSizeMultiplier={1.6} style={{ color: c.text, fontSize: type.heading, fontWeight: '800' }}>{children}</Text>;
}
export function Section({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.title, fontWeight: '700', marginTop: space.xl, marginBottom: space.sm }}>{children}</Text>;
}
export function Body({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  const c = useColors();
  return <Text style={{ color: muted ? c.muted : c.text, fontSize: type.body, lineHeight: 22 }}>{children}</Text>;
}

export function Button({ label, onPress, kind = 'primary', accessibilityLabel }: { label: string; onPress: () => void; kind?: 'primary' | 'quiet'; accessibilityLabel?: string }) {
  const c = useColors();
  const primary = kind === 'primary';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: primary ? c.accent : c.surfaceAlt, opacity: pressed ? 0.85 : 1 }]}>
      <Text style={{ color: primary ? c.accentText : c.text, fontSize: type.body, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const c = useColors();
  const [bg, fg] = tone === 'good' ? [c.successSoft, c.success] : tone === 'warn' ? [c.warningSoft, c.warning] : tone === 'bad' ? [c.dangerSoft, c.danger] : [c.surfaceAlt, c.muted];
  return <View style={[styles.pill, { backgroundColor: bg }]}><Text style={{ color: fg, fontSize: type.caption, fontWeight: '700' }}>{text}</Text></View>;
}

export function StateMessage({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <Card style={{ marginTop: space.xl }}>
      <Text accessibilityRole="header" style={{ fontSize: type.title, fontWeight: '700', color: useColors().text, marginBottom: space.sm }}>{title}</Text>
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
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, marginBottom: space.md },
  button: { minHeight: TOUCH, borderRadius: radius.pill, paddingHorizontal: space.xl, alignItems: 'center', justifyContent: 'center' },
  pill: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
});
