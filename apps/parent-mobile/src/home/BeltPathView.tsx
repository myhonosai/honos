import React from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '../ui/text';
import { Icon } from '../ui/icons';
import { eianImage } from '../eian/avatar';
import { EDGE, radius, space, type, useColors } from '../ui/theme';
import type { FamilyJourneyRecommendation } from '@hon/contracts/journey-recommendations';
import type { BeltPath, PathStep } from './belt-path';
import { GiftStop } from './Recommendations';

/** Horizontal offsets that make the stops wind left and right like a path. */
const WIND = [0, -56, -24, 40, 64, 16, -48, -12];
const NODE = 68;

/**
 * One child's belt path on Home: a banner (program, rank, requirements met), then the stops, then the next belt.
 * The banner opens the child's journey. Gift stops (0603, what the school recommends at this point) are their own buttons,
 * placed just before the next belt.
 */
export function BeltPathView({ childName, program, rank, path, cheer, onOpen, gifts = [], onGift }: {
  childName: string; program: string | null; rank: string | null; path: BeltPath; cheer: string | null; onOpen: () => void;
  gifts?: FamilyJourneyRecommendation[]; onGift?: (item: FamilyJourneyRecommendation) => void;
}) {
  const c = useColors();
  const summary = path.available && path.total > 0 ? `${path.met} of ${path.total} requirements met` : null;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${childName} journey`} accessibilityHint={summary ?? undefined} onPress={onOpen}>
      <View style={[styles.banner, { backgroundColor: c.accent, borderBottomColor: c.accentEdge }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.accentText, opacity: 0.85, fontSize: type.caption, fontWeight: '800', letterSpacing: 1 }}>{[childName, program].filter(Boolean).join(' · ').toUpperCase()}</Text>
          <Text style={{ color: c.accentText, fontSize: type.title, fontWeight: '800', marginTop: 2 }}>{rank ? `${rank} journey` : 'No rank recorded yet'}</Text>
        </View>
        {summary ? (
          <View style={[styles.count, { backgroundColor: c.surface }]}>
            <Icon name="star" size={18} color={c.sun} />
            <Text style={{ color: c.text, fontWeight: '800', fontSize: type.body }}>{path.met}/{path.total}</Text>
          </View>
        ) : null}
      </View>
      </Pressable>

      {!path.available ? <Text style={[styles.note, { color: c.muted }]}>Requirements aren't available right now.</Text>
        : path.total === 0 ? <Text style={[styles.note, { color: c.muted }]}>The school hasn't listed requirements for this rank.</Text>
        : (
          <View style={styles.path}>
            {cheer ? (
              <View style={styles.eianRow}>
                <Image source={eianImage('chibi', 'speaking')} style={[styles.eian, { borderColor: c.surface }]} accessibilityIgnoresInvertColors />
                <View style={[styles.bubble, { backgroundColor: c.surface, borderColor: c.edge }]}>
                  <Text style={{ color: c.text, fontWeight: '700', fontSize: type.body }}>{cheer}</Text>
                </View>
              </View>
            ) : null}
            {path.steps.map((step, i) => <Stop key={`s-${i}`} step={step} offset={WIND[i % WIND.length]!} />)}
            {path.more ? <Text style={[styles.more, { color: c.muted }]}>+{path.more} more in {childName}'s journey</Text> : null}
            {gifts.map(g => <GiftStop key={g.recommendationId} item={g} onOpen={() => onGift?.(g)} />)}
            <View style={[styles.goal, { backgroundColor: c.sun, borderBottomColor: c.sunEdge }]}><Icon name="belt" size={36} color="#FFFFFF" /></View>
            <Text style={{ color: c.warning, fontWeight: '800', textAlign: 'center', marginTop: space.sm }}>Next belt</Text>
          </View>
        )}
      {(!path.available || path.total === 0) ? gifts.map(g => <GiftStop key={g.recommendationId} item={g} onOpen={() => onGift?.(g)} />) : null}
    </View>
  );
}

function Stop({ step, offset }: { step: PathStep; offset: number }) {
  const c = useColors();
  const [face, edge, fg] = step.state === 'done' ? [c.lime, c.limeEdge, '#FFFFFF'] : step.state === 'next' ? [c.accent, c.accentEdge, '#FFFFFF'] : [c.surfaceAlt, c.edge, c.subtle];
  const said = step.state === 'done' ? 'met' : step.state === 'next' ? 'next up' : 'still to come';
  return (
    <View accessible accessibilityLabel={`${step.label}: ${said}${step.required ? '' : ', optional'}`} style={{ alignItems: 'center', transform: [{ translateX: offset }], marginTop: space.md }}>
      {step.state === 'next' ? (
        <View style={[styles.tip, { backgroundColor: c.text }]}><Text numberOfLines={1} style={{ color: c.bg, fontWeight: '800', fontSize: type.caption }}>Next: {step.label}</Text></View>
      ) : null}
      <View style={step.state === 'next' ? [styles.ring, { borderColor: c.accentSoft }] : null}>
        <View style={[styles.node, { backgroundColor: face, borderBottomColor: edge }]}>
          <Icon name={step.state === 'done' ? 'check' : step.state === 'next' ? 'kick' : 'star'} size={30} color={fg} />
        </View>
      </View>
      {step.state !== 'next' ? <Text numberOfLines={1} style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', marginTop: 4, maxWidth: 160 }}>{step.label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: space.md, borderRadius: radius.lg, padding: space.lg, borderBottomWidth: EDGE + 1 },
  count: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
  note: { marginTop: space.md, fontSize: type.body },
  path: { paddingVertical: space.md, alignItems: 'center' },
  eianRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, alignSelf: 'stretch' },
  eian: { width: 64, height: 64, borderRadius: radius.pill, borderWidth: 3 },
  bubble: { flex: 1, borderWidth: 2, borderBottomWidth: 2 + EDGE, borderRadius: radius.md, padding: space.md },
  node: { width: NODE, height: NODE - 6, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', borderBottomWidth: EDGE + 3 },
  ring: { borderWidth: 6, borderRadius: radius.pill, padding: 3 },
  tip: { borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 6, marginBottom: space.sm, maxWidth: 260 },
  more: { marginTop: space.md, fontWeight: '700' },
  goal: { width: 84, height: 72, borderRadius: 26, alignItems: 'center', justifyContent: 'center', borderBottomWidth: EDGE + 3, marginTop: space.lg },
});
