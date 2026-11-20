import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ParentJourneyView } from '@hon/contracts/parent-journey-view';
import { useFamily } from '../family/family-data';
import { SchoolAnnouncements, useAnnouncements } from '../home/Announcements';
import { StreakBar, useStreaks } from '../home/Streaks';
import { bookingLabel, childSummaries, formatClassTime, nextClass } from '../home/model';
import { beltPath, eianCheer } from '../home/belt-path';
import { BeltPathView } from '../home/BeltPathView';
import { giftsFor, RecommendationSheet, useRecommendations, type JourneyGo } from '../home/Recommendations';
import type { FamilyJourneyRecommendation } from '@hon/contracts/journey-recommendations';
import { Icon } from '../ui/icons';
import { Body, Button, Card, Pill, Section, Title } from '../ui/parts';
import { EDGE, radius, space, TOUCH, type, useColors } from '../ui/theme';
import { FamilyGate } from './FamilyStates';
import { JourneyView } from './JourneyView';

const ACCESS_LABEL: Record<ParentJourneyView['accessLevel'], string> = {
  PRIMARY_GUARDIAN: 'Primary guardian', SECONDARY_GUARDIAN: 'Guardian', VIEWER: 'View only',
};

export function HomeScreen({ onNavigate, onJourneyGo }: { onNavigate: (tab: 'Schedule' | 'Eian' | 'Messages') => void; onJourneyGo?: (go: JourneyGo) => void }) {
  const { state, selection, select, refresh, now, api } = useFamily();
  const announcements = useAnnouncements(api, state.status === 'ready' ? state.view : null);
  const streaks = useStreaks(api, state.status === 'ready' ? state.view : null);
  const recommendations = useRecommendations(api, state.status === 'ready' ? state.view : null);
  const [gift, setGift] = useState<FamilyJourneyRecommendation | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [openChild, setOpenChild] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const c = useColors();

  if (state.status === 'ready' && openChild !== null && state.view.children[openChild]) {
    return <JourneyView child={state.view.children[openChild]!} timeZone={state.timeZone} now={now()} onBack={() => setOpenChild(null)} />;
  }

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }}
      refreshControl={<RefreshControl refreshing={state.status === 'loading'} onRefresh={refresh} />}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 1 }}>HON FAMILY</Text>
          <Title>Your family</Title>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh" onPress={refresh} style={[styles.iconButton, { backgroundColor: c.surface, borderColor: c.edge }]}>
          <Icon name="refresh" size={22} color={c.accent} />
        </Pressable>
      </View>
      <FamilyGate state={state} />
      {state.status === 'ready' ? <Ready view={state.view} timeZone={state.timeZone} /> : null}
      <RecommendationSheet item={gift} onClose={() => setGift(null)}
        onNotNow={id => { setHidden(prev => new Set([...prev, id])); setGift(null); }}
        onGo={go => { setGift(null); if (onJourneyGo) onJourneyGo(go); else if (go.tab === 'Messages') onNavigate('Messages'); }} />
    </ScrollView>
  );

  function Ready({ view, timeZone }: { view: ParentJourneyView; timeZone: string | null }) {
    const children = childSummaries(view);
    const next = nextClass(view, selection, now());
    const when = next ? formatClassTime(next.booking.startsAt, timeZone) : null;
    return (
      <View>
        <View style={{ flexDirection: 'row', marginTop: space.sm }}><Pill text={ACCESS_LABEL[view.accessLevel]} /></View>
        <StreakBar read={streaks} names={selection === 'all' ? null : children.filter(ch => ch.index === selection).map(ch => ch.name)} />
        {children.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.lg }} contentContainerStyle={{ gap: space.sm }}>
            <Chip label="All children" active={selection === 'all'} onPress={() => select('all')} a11y="Show all children" />
            {children.map(ch => <Chip key={ch.key} label={ch.name} active={selection === ch.index} onPress={() => select(ch.index)} a11y={`Show ${ch.name}`} />)}
          </ScrollView>
        ) : null}

        <SchoolAnnouncements read={announcements} timeZone={timeZone} />

        <Section>Next class</Section>
        {next && when ? (
          <Card label={`Next class: ${next.booking.name} for ${next.childName}, ${bookingLabel(next.booking.bookingStatus)}, ${when.text}`} style={{ backgroundColor: c.accent, borderColor: c.accent, borderBottomColor: c.accentEdge }}>
            <Text style={{ color: c.accentText, fontSize: type.caption, fontWeight: '700', opacity: 0.9 }}>{next.childName.toUpperCase()}</Text>
            <Text style={{ color: c.accentText, fontSize: type.heading, fontWeight: '800', marginTop: space.xs }}>{next.booking.name}</Text>
            <Text style={{ color: c.accentText, fontSize: type.body, marginTop: space.xs }}>{when.text}{next.booking.room ? ` · ${next.booking.room}` : ''}</Text>
            {when.zoneNote ? <Text style={{ color: c.accentText, fontSize: type.caption, opacity: 0.85 }}>{when.zoneNote}</Text> : null}
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.md }}>
              <View style={[styles.onAccent]}><Text style={{ color: c.accent, fontWeight: '800', fontSize: type.caption }}>{bookingLabel(next.booking.bookingStatus)}</Text></View>
              {next.booking.kind === 'MAKEUP' ? <View style={styles.onAccent}><Text style={{ color: c.accent, fontWeight: '800', fontSize: type.caption }}>Makeup</Text></View> : null}
            </View>
          </Card>
        ) : (
          <Card><Body muted>No upcoming classes are on the schedule for the next four weeks.</Body></Card>
        )}

        <Section>Progress</Section>
        {children.length === 0 ? <Card><Body muted>No children are linked to this family yet.</Body></Card> : null}
        {children.filter(ch => selection === 'all' || ch.index === selection).map(ch => {
          const program = view.children[ch.index]!.programs[0];
          if (!ch.profileAvailable || !program) {
            return (
              <Pressable key={ch.key} accessibilityRole="button" accessibilityLabel={`Open ${ch.name} journey`} onPress={() => setOpenChild(ch.index)}>
                <Card><Text style={{ color: c.text, fontSize: type.title, fontWeight: '700' }}>{ch.name}</Text>
                  <Text style={{ color: c.muted, fontSize: type.body }}>{ch.profileAvailable ? 'No program recorded' : 'Profile not available'}</Text></Card>
              </Pressable>
            );
          }
          const path = beltPath(program);
          const first = ch.name.split(/\s+/)[0] || ch.name;
          return (
            <View key={ch.key} style={{ marginBottom: space.lg }}>
              <BeltPathView childName={ch.name} program={ch.program} rank={ch.rank} path={path} cheer={eianCheer(first, path)} onOpen={() => setOpenChild(ch.index)}
                gifts={giftsFor(recommendations, ch.name, hidden)} onGift={setGift} />
              {ch.latestAchievement ? <View style={{ marginTop: space.sm }}><Pill tone="good" text={`★ ${ch.latestAchievement}`} /></View> : null}
            </View>
          );
        })}

        {view.documents.status === 'AVAILABLE' && view.documents.items.length ? (
          <>
            <Section>From your school</Section>
            {view.documents.items.slice(0, 3).map((d, i) => <Card key={`doc-${i}`}><Body>{d.title}</Body></Card>)}
          </>
        ) : null}

        <Section>Quick actions</Section>
        <View style={{ gap: space.sm }}>
          <Button kind="quiet" label="My schedule" onPress={() => onNavigate('Schedule')} />
          <Button kind="quiet" label="Messages" onPress={() => onNavigate('Messages')} />
          <Button label="Ask Eian" onPress={() => onNavigate('Eian')} />
        </View>
      </View>
    );
  }
}

function Chip({ label, active, onPress, a11y }: { label: string; active: boolean; onPress: () => void; a11y: string }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} accessibilityState={{ selected: active }} onPress={onPress}
      style={[styles.chip, active ? { backgroundColor: c.accentSoft, borderColor: c.accent } : { backgroundColor: c.surface, borderColor: c.edge }]}>
      <Text style={{ color: active ? c.accentEdge : c.text, fontWeight: '800', fontSize: type.body }}>{label}</Text>
    </Pressable>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => [...p][0]!.toUpperCase()).join('') || '?';
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  iconButton: { width: TOUCH, height: TOUCH, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderBottomWidth: 2 + EDGE },
  chip: { minHeight: 44, paddingHorizontal: space.lg, borderRadius: radius.md, justifyContent: 'center', borderWidth: 2, borderBottomWidth: 2 + EDGE },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  onAccent: { backgroundColor: '#FFFFFF', borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
});
