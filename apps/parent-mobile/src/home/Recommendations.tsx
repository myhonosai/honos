import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { isJourneySiblingName, JOURNEY_SIBLING_NAME_MAX, type FamilyJourneyRecommendation, type ParentJourneyRecommendations } from '@hon/contracts/journey-recommendations';
import type { ParentApi, ParentRead } from '../api/client';
import { Text } from '../ui/text';
import { Icon } from '../ui/icons';
import { Body, Button } from '../ui/parts';
import { eianImage } from '../eian/avatar';
import { EDGE, radius, space, type, useColors } from '../ui/theme';

/** Where a recommendation can take the family. The app only opens its own screens; nothing is bought or sent from here. */
export type JourneyGo = { tab: 'More'; area: 'checkout' | 'events' | 'shop' } | { tab: 'Messages' };

export function useRecommendations(api: ParentApi, reload: unknown): ParentRead<ParentJourneyRecommendations> | null {
  const [read, setRead] = useState<ParentRead<ParentJourneyRecommendations> | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const mine = ++generation.current;
    const result = await api.journeyRecommendations();
    if (mine === generation.current) setRead(result);
  }, [api]);
  useEffect(() => { if (reload !== null) void load(); return () => { generation.current++; }; }, [load, reload]);
  return read;
}

/** The verified recommendations for one child, minus any the family closed with "Not now" in this visit. Nothing on failure. */
export function giftsFor(read: ParentRead<ParentJourneyRecommendations> | null, childName: string, hidden: ReadonlySet<string>): FamilyJourneyRecommendation[] {
  if (!read || !read.ok) return [];
  const child = read.data.children.find(ch => ch.name === childName);
  return child ? child.recommendations.filter(r => !hidden.has(r.recommendationId)) : [];
}

/** The main button for a recommendation, or null when the only way forward is asking the school. */
export function seeAction(r: FamilyJourneyRecommendation): { label: string; go: JourneyGo } | null {
  if (r.targetKind === 'CHECKOUT') return { label: 'See how to join', go: { tab: 'More', area: 'checkout' } };
  if (r.targetKind === 'EVENT') return { label: 'See the event', go: { tab: 'More', area: 'events' } };
  if (r.targetKind === 'PRO_SHOP') return { label: 'Open the pro shop', go: { tab: 'More', area: 'shop' } };
  return null;
}

/** A gift stop on the belt path. Its own button, so it never opens the journey by accident. */
export function GiftStop({ item, onOpen }: { item: FamilyJourneyRecommendation; onOpen: () => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`From your school: ${item.title}`} onPress={onOpen}
      style={({ pressed }) => [styles.gift, { backgroundColor: c.coralSoft, borderColor: c.coral, borderBottomColor: c.coral }, pressed ? { transform: [{ translateY: 2 }] } : null]}>
      <View style={[styles.box, { backgroundColor: c.coral }]}><Icon name="gift" size={26} color="#FFFFFF" /></View>
      <Text numberOfLines={2} style={{ flex: 1, color: c.text, fontWeight: '800', fontSize: type.body }}>{item.title}</Text>
    </Pressable>
  );
}

/** Who a family's interest is for: the child whose path showed the gift, or a brother or sister named by the guardian. */
export type JourneyFor = { childName: string; sibling: boolean };

/**
 * The sheet a gift stop opens: the school's own words, then where to go next. For a guardian, going on first asks who it is
 * for (0608), because the school gets that name as someone to follow up with. A view-only member just goes on.
 */
export function RecommendationSheet({ item, childName = null, tellsSchool = false, onGo, onNotNow, onClose }: {
  item: FamilyJourneyRecommendation | null; childName?: string | null; tellsSchool?: boolean;
  onGo: (go: JourneyGo, item: FamilyJourneyRecommendation, who: JourneyFor | null) => void; onNotNow: (id: string) => void; onClose: () => void;
}) {
  const c = useColors();
  const see = item ? seeAction(item) : null;
  const [pending, setPending] = useState<JourneyGo | null>(null);
  const [sibling, setSibling] = useState(false);
  const [name, setName] = useState('');
  const id = item?.recommendationId ?? null;
  useEffect(() => { setPending(null); setSibling(false); setName(''); }, [id]);
  const asks = tellsSchool && childName !== null;
  const typed = name.trim().replace(/\s+/g, ' ');
  const who: JourneyFor | null = !asks ? null : sibling ? (isJourneySiblingName(typed) ? { childName: typed, sibling: true } : null) : { childName: childName!, sibling: false };
  const start = (go: JourneyGo) => { if (!item) return; if (asks) setPending(go); else onGo(go, item, null); };
  const choice = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={label} onPress={onPress}
      style={[styles.choice, { borderColor: selected ? c.accent : c.edge, backgroundColor: selected ? c.surface : c.bg }]}>
      <Text style={{ color: c.text, fontSize: type.body, fontWeight: selected ? '800' : '600' }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible={item !== null} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {item ? (
          <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: c.bg, borderColor: c.edge }]}>
            <View style={styles.head}>
              <Image source={eianImage('chibi', 'speaking')} style={[styles.eian, { borderColor: c.surface }]} accessibilityIgnoresInvertColors />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '800', letterSpacing: 1 }}>{`FROM YOUR SCHOOL · ${item.program}`.toUpperCase()}</Text>
                <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.title, fontWeight: '800' }}>{item.title}</Text>
              </View>
            </View>
            {pending ? (
              <>
                <Text accessibilityRole="header" style={{ color: c.text, fontSize: type.body, fontWeight: '800', marginTop: space.md }}>Who is this for?</Text>
                <View accessibilityRole="radiogroup" style={{ gap: space.sm, marginTop: space.sm }}>
                  {choice(childName!, !sibling, () => setSibling(false))}
                  {choice('A brother or sister', sibling, () => setSibling(true))}
                </View>
                {sibling ? (
                  <TextInput accessibilityLabel="Brother or sister's name" value={name} onChangeText={setName} maxLength={JOURNEY_SIBLING_NAME_MAX} autoCapitalize="words"
                    placeholder="Their name" placeholderTextColor={c.subtle}
                    style={[styles.input, { color: c.text, borderColor: c.edge, backgroundColor: c.surface }]} />
                ) : null}
                <Text style={{ color: c.muted, fontSize: type.caption, marginTop: space.md }}>Your school will see this name so they can follow up. Nothing is sent, booked or bought.</Text>
                <View style={{ gap: space.sm, marginTop: space.lg }}>
                  {who ? <Button kind="go" label="Continue" onPress={() => onGo(pending, item, who)} /> : <Body muted>Type their name to continue.</Body>}
                  <Button kind="quiet" label="Back" onPress={() => setPending(null)} />
                </View>
              </>
            ) : (
              <>
                <Text style={{ color: c.text, fontSize: type.body, marginTop: space.md }}>{item.message}</Text>
                {item.targetLabel ? <Text style={{ color: c.muted, fontSize: type.body, fontWeight: '700', marginTop: space.sm }}>{item.targetLabel}</Text> : null}
                <View style={{ gap: space.sm, marginTop: space.xl }}>
                  {see ? <Button kind="go" label={see.label} onPress={() => start(see.go)} /> : null}
                  <Button kind={see ? 'quiet' : 'go'} label="Ask the school" onPress={() => start({ tab: 'Messages' })} />
                  <Button kind="quiet" label="Not now" accessibilityLabel="Not now, hide this for now" onPress={() => onNotNow(item.recommendationId)} />
                  <Button kind="quiet" label="Close" onPress={onClose} />
                </View>
              </>
            )}
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  gift: { flexDirection: 'row', alignItems: 'center', gap: space.md, alignSelf: 'stretch', borderWidth: 2, borderBottomWidth: 2 + EDGE, borderRadius: radius.lg, padding: space.md, marginTop: space.lg, minHeight: 64 },
  box: { width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 2, padding: space.xl, paddingBottom: space.xxl },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  eian: { width: 56, height: 56, borderRadius: radius.pill, borderWidth: 3 },
  choice: { borderWidth: 2, borderRadius: radius.md, padding: space.md, minHeight: 48, justifyContent: 'center' },
  input: { borderWidth: 2, borderRadius: radius.md, padding: space.md, marginTop: space.sm, fontSize: type.body, minHeight: 48 },
});
