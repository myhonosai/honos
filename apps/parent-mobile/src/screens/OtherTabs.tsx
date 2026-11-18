import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFamily } from '../family/family-data';
import { bookingLabel, formatClassTime } from '../home/model';
import { Body, Button, Card, Pill, Section, Title } from '../ui/parts';
import { space, type, useColors } from '../ui/theme';
import { FamilyGate } from './FamilyStates';
import { BookClasses } from '../schedule/BookClasses';
import { ReportAbsence } from '../schedule/ReportAbsence';

function Page({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: space.xxl }}>
      <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700', letterSpacing: 1 }}>{eyebrow}</Text>
      <Title>{title}</Title>
      {children}
    </ScrollView>
  );
}

/** Schedule from the verified journey (next four weeks), then booking and cancelling from the class booking read. */
export function ScheduleScreen() {
  const { state, selection, now } = useFamily();
  const c = useColors();
  if (state.status !== 'ready') return <Page eyebrow="SCHEDULE" title="Classes"><FamilyGate state={state} /></Page>;
  const rows = state.view.children.flatMap((child, index) => (selection === 'all' || selection === index) && child.schedule.status === 'AVAILABLE'
    ? child.schedule.items.filter(b => Date.parse(b.startsAt) > now().getTime()).map(b => ({ child: child.name, b })) : [])
    .sort((x, y) => Date.parse(x.b.startsAt) - Date.parse(y.b.startsAt));
  const note = formatClassTime(new Date().toISOString(), state.timeZone).zoneNote;
  return (
    <Page eyebrow="SCHEDULE" title="Classes">
      {note ? <Text style={{ color: c.subtle, marginTop: space.sm }}>{note}</Text> : null}
      {rows.length === 0 ? <Card style={{ marginTop: space.lg }}><Body muted>No upcoming classes in the next four weeks.</Body></Card> : null}
      <View style={{ marginTop: space.lg }}>
        {rows.map(({ child, b }, i) => (
          <Card key={`s-${i}`} label={`${b.name} for ${child}, ${formatClassTime(b.startsAt, state.timeZone).text}, ${bookingLabel(b.bookingStatus)}`}>
            <Text style={{ color: c.muted, fontSize: type.caption, fontWeight: '700' }}>{formatClassTime(b.startsAt, state.timeZone).text.toUpperCase()}</Text>
            <Text style={{ color: c.text, fontSize: type.title, fontWeight: '700', marginTop: space.xs }}>{b.name}</Text>
            <Text style={{ color: c.muted }}>{child}{b.room ? ` · ${b.room}` : ''}</Text>
            <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
              <Pill tone={b.bookingStatus === 'BOOKED' || b.bookingStatus === 'CHECKED_IN' ? 'good' : 'warn'} text={bookingLabel(b.bookingStatus)} />
              {b.kind === 'MAKEUP' ? <Pill text="Makeup" /> : null}
            </View>
          </Card>
        ))}
      </View>
      <BookClasses />
      <ReportAbsence />
    </Page>
  );
}

export function SignInScreen({ onSignIn, onTrySample }: { onSignIn?: () => Promise<'signed-in' | 'cancelled' | 'failed'>; onTrySample?: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const start = async () => {
    if (!onSignIn || busy) return;
    setBusy(true); setFailed(false);
    const result = await onSignIn();
    setBusy(false);
    if (result === 'failed') setFailed(true);
  };
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: space.xl, paddingTop: insets.top + space.xxl, justifyContent: 'center' }}>
      <Text style={{ color: c.accent, fontSize: type.caption, fontWeight: '800', letterSpacing: 2 }}>HON</Text>
      <Title>Sign in to your school</Title>
      <View style={{ height: space.md }} />
      <Body muted>Use the account your martial arts school invited. Your family, children and school come from the school's records, never from what is typed on this phone.</Body>
      {onSignIn ? (
        <View style={{ marginTop: space.xl }}>
          <Button label={busy ? 'Opening sign-in…' : 'Sign in'} accessibilityLabel="Sign in" onPress={() => { void start(); }} />
          {failed ? <Card style={{ marginTop: space.lg }}><Body muted>We couldn't finish signing in. Please try again. If it keeps happening, contact your school.</Body></Card> : null}
        </View>
      ) : <Card style={{ marginTop: space.xl }}><Body muted>Signing in from the app is being connected. Until then, please use the HON parent website your school shared.</Body></Card>}
      {onTrySample ? (
        <View style={{ marginTop: space.xl }}>
          <Button kind="quiet" label="Try with a sample family" onPress={onTrySample} />
          <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.sm, textAlign: 'center' }}>Test builds only. Made-up data that never leaves this phone.</Text>
        </View>
      ) : null}
    </View>
  );
}
