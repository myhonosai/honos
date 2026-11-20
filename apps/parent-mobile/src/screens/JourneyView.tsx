import React from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from '../ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { JourneyChild, JourneyRequirement } from '@hon/contracts/parent-journey-view';
import { bookingLabel, formatAwardDate, formatClassTime, upcomingFor } from '../home/model';
import { Body, Card, Pill, Section, Title } from '../ui/parts';
import { space, TOUCH, type, useColors } from '../ui/theme';

const STATUS: Record<NonNullable<JourneyRequirement['status']>, { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  MET: { text: 'Met', tone: 'good' }, DEMONSTRATED: { text: 'Demonstrated', tone: 'good' }, PRACTICING: { text: 'Practicing', tone: 'warn' },
  NOT_STARTED: { text: 'Not started', tone: 'neutral' }, NOT_MET: { text: 'Not yet', tone: 'bad' },
};

/** One child's journey, exactly as the school recorded it. Nothing here is computed into eligibility or rank. */
export function JourneyView({ child, timeZone, now, onBack }: { child: JourneyChild; timeZone: string | null; now: Date; onBack: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const upcoming = upcomingFor(child, now, 5);
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.md, paddingBottom: space.xxl }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to family" onPress={onBack} style={styles.back}>
        <Text style={{ color: c.accent, fontSize: type.body, fontWeight: '700' }}>‹ Family</Text>
      </Pressable>
      <Title>{child.name}</Title>
      {!child.profileAvailable ? <Card style={{ marginTop: space.lg }}><Body muted>The school hasn't made this profile available in the app.</Body></Card> : null}

      {child.programs.map((p, i) => (
        <View key={`p-${i}`}>
          <Section>{p.name}</Section>
          <Card>
            <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>CURRENT RANK</Text>
            <Text style={{ color: c.text, fontSize: type.heading, fontWeight: '800', marginTop: space.xs }}>{p.rank ?? 'Not recorded'}</Text>
          </Card>
          {p.requirements.status === 'AVAILABLE' ? (
            <Card>
              <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', marginBottom: space.sm }}>REQUIREMENTS FOR THE NEXT RANK</Text>
              {p.requirements.items.length === 0 ? <Body muted>The school hasn't listed requirements for this rank.</Body> : null}
              {p.requirements.items.map((r, j) => (
                <View key={`r-${j}`} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: c.text, fontSize: type.body }}>{r.label}</Text>
                    {!r.required ? <Text style={{ color: c.subtle, fontSize: type.caption }}>Optional</Text> : null}
                  </View>
                  {r.status ? <Pill tone={STATUS[r.status].tone} text={STATUS[r.status].text} /> : <Pill text="Not recorded yet" />}
                </View>
              ))}
              <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Only instructors record results. Testing eligibility is decided by the school.</Text>
            </Card>
          ) : <Card><Body muted>Requirements aren't available right now.</Body></Card>}
        </View>
      ))}

      <Section>Achievements</Section>
      {child.achievements.status !== 'AVAILABLE' ? <Card><Body muted>Achievements aren't available right now.</Body></Card>
        : child.achievements.items.length === 0 ? <Card><Body muted>No achievements have been awarded yet.</Body></Card>
        : child.achievements.items.map((a, i) => (
          <Card key={`a-${i}`}>
            <View style={{ flexDirection: 'row', gap: space.sm }}><Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: c.warning, fontSize: type.body }}>★</Text><Text style={{ color: c.text, fontSize: type.body, fontWeight: '700' }}>{a.name}</Text></View>
            {a.description ? <Body muted>{a.description}</Body> : null}
            <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.xs }}>Awarded {formatAwardDate(a.awardedOn)}</Text>
          </Card>
        ))}

      <Section>Upcoming</Section>
      {child.schedule.status !== 'AVAILABLE' ? <Card><Body muted>The schedule isn't available right now.</Body></Card>
        : upcoming.length === 0 ? <Card><Body muted>No upcoming classes in the next four weeks.</Body></Card>
        : upcoming.map((b, i) => {
          const when = formatClassTime(b.startsAt, timeZone);
          return (
            <Card key={`b-${i}`}>
              <View style={styles.row}>
                <View style={{ flex: 1 }}><Text style={{ color: c.text, fontSize: type.body, fontWeight: '700' }}>{b.name}</Text><Text style={{ color: c.muted }}>{when.text}</Text></View>
                <Pill tone={b.bookingStatus === 'BOOKED' ? 'good' : 'warn'} text={bookingLabel(b.bookingStatus)} />
              </View>
            </Card>
          );
        })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: TOUCH, justifyContent: 'center', alignSelf: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
});
