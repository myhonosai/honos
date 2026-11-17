import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFamily } from '../family/family-data';
import { bookingLabel, formatClassTime } from '../home/model';
import { Body, Button, Card, Pill, Section, Title } from '../ui/parts';
import { space, type, useColors } from '../ui/theme';
import { FamilyGate } from './FamilyStates';
import { BookClasses } from '../schedule/BookClasses';

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
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.md }}>Reporting an absence from the app is coming in the next update. You can do it on the HON parent website today.</Text>
    </Page>
  );
}

export function EianScreen() {
  const c = useColors();
  return (
    <Page eyebrow="YOUR FAMILY ASSISTANT" title="Eian">
      <Card style={{ marginTop: space.lg, backgroundColor: c.accentSoft, borderColor: c.accentSoft }}>
        <Text style={{ color: c.text, fontSize: type.title, fontWeight: '800' }}>Eian is not connected yet.</Text>
        <Body muted>When Eian arrives, it will answer from your family's real school records and always ask you before booking, cancelling or sending anything. Everything Eian does will also be possible with normal buttons.</Body>
      </Card>
      <Section>Things you'll be able to ask</Section>
      {["What's my son's next class?", 'What does she need for her next belt?', 'When is the next belt test?', 'Do we have any unpaid invoices?'].map(q => (
        <Card key={q}><Body>“{q}”</Body></Card>
      ))}
    </Page>
  );
}

export function MessagesScreen() {
  return (
    <Page eyebrow="MESSAGES" title="Your school">
      <Card style={{ marginTop: space.lg }}><Body muted>Messages with your school are not connected in this version of the app yet. You can message the school from the HON parent website today.</Body></Card>
    </Page>
  );
}

export function MoreScreen({ onSignOut, version }: { onSignOut: () => void; version: string }) {
  const c = useColors();
  return (
    <Page eyebrow="MORE" title="Account">
      <Section>Coming next</Section>
      <Card><Body muted>Membership and billing, belt testing, documents, curriculum, events and settings will appear here as each one is connected.</Body></Card>
      <Section>Security</Section>
      <Button kind="quiet" label="Sign out" onPress={onSignOut} />
      <Text style={{ color: c.subtle, fontSize: type.caption, marginTop: space.xl, textAlign: 'center' }}>HON Family {version}</Text>
    </Page>
  );
}

export function SignInScreen({ onSignIn }: { onSignIn?: () => Promise<'signed-in' | 'cancelled' | 'failed'> }) {
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
    </View>
  );
}
