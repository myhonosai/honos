import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StaffApi, StaffFailureState, StaffSchool } from './api/client';
import type { SessionStore } from './session/session-store';
import { T } from './ui/theme';

type SignInResult = 'signed-in' | 'cancelled' | 'failed';
export interface StaffAppProps {
  api: StaffApi;
  session: Pick<SessionStore, 'token' | 'clear' | 'subscribe'>;
  /** Absent when this build has no valid HON web address: the app then cannot sign in at all. */
  onSignIn?: () => Promise<SignInResult>;
  version: string;
}

type View_ =
  | { kind: 'loading' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'failed'; state: Exclude<StaffFailureState, 'signed-out'> }
  | { kind: 'choose'; schools: StaffSchool[] }
  | { kind: 'home'; school: StaffSchool; schools: StaffSchool[] | null };


function Button({ label, onPress, quiet }: { label: string; onPress: () => void; quiet?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={[s.button, quiet && s.quiet]}>
      <Text style={[s.buttonText, quiet && s.quietText]}>{label}</Text>
    </Pressable>
  );
}

function Pill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={s.pill}>
      <Text style={s.pillText}>{label}</Text>
    </Pressable>
  );
}

const FAILED: Record<Exclude<StaffFailureState, 'signed-out'>, { title: string; body: string }> = {
  'no-staff-access': { title: 'This account has no staff access at a HON school.', body: 'Ask your school owner to invite you as staff, then sign in again.' },
  unavailable: { title: 'HON is not available right now.', body: 'Nothing was changed. Try again in a moment.' },
  offline: { title: 'You are offline.', body: 'Connect to the internet and try again.' },
};

/**
 * S0b: sign in, find the school the person works at (choose when there are several), and a signed-in home. The
 * chosen school lives only in memory: it is where the app will look, never permission. Later phases add Today,
 * People, HON (with Kai and the AI team), Texts and Me.
 */
export function StaffApp({ api, session, onSignIn, version }: StaffAppProps) {
  const [view, setView] = useState<View_>({ kind: 'loading' });

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    if (!(await session.token())) { setView({ kind: 'signed-out' }); return; }
    const result = await api.whereIWork();
    if (!result.ok) {
      if (result.state === 'signed-out') { await session.clear(); setView({ kind: 'signed-out' }); return; }
      setView({ kind: 'failed', state: result.state });
      return;
    }
    setView(result.data.kind === 'one' ? { kind: 'home', school: result.data.school, schools: null } : { kind: 'choose', schools: result.data.schools });
  }, [api, session]);

  useEffect(() => { void load(); }, [load]);

  const signIn = async () => {
    if (!onSignIn) return;
    const outcome = await onSignIn();
    if (outcome === 'signed-in') await load();
    else setView({ kind: 'signed-out', message: outcome === 'failed' ? 'Sign-in did not finish. Please try again.' : undefined });
  };
  const signOut = async () => { await session.clear(); setView({ kind: 'signed-out' }); };

  let body: React.ReactNode;
  switch (view.kind) {
    case 'loading':
      body = <ActivityIndicator accessibilityLabel="Loading" color={T.ink} />;
      break;
    case 'signed-out':
      body = (
        <View style={s.card}>
          <Text style={s.title}>HON Staff</Text>
          <Text style={s.body}>Sign in with your HON staff account.</Text>
          {view.message ? <Text style={s.alert}>{view.message}</Text> : null}
          {onSignIn ? <Button label="Sign in" onPress={() => void signIn()} /> : <Text style={s.alert}>This build cannot sign in yet. Please update the app.</Text>}
        </View>
      );
      break;
    case 'failed':
      body = (
        <View style={s.card}>
          <Text style={s.title}>{FAILED[view.state].title}</Text>
          <Text style={s.body}>{FAILED[view.state].body}</Text>
          <Button label="Try again" onPress={() => void load()} />
          <Button label="Sign out" quiet onPress={() => void signOut()} />
        </View>
      );
      break;
    case 'choose':
      body = (
        <View style={s.card}>
          <Text style={s.title}>Which school are you working at?</Text>
          {view.schools.map(school => (
            <Pressable key={school.schoolId} accessibilityRole="button" accessibilityLabel={school.schoolName ?? 'Your school'} style={s.row}
              onPress={() => setView({ kind: 'home', school, schools: view.schools })}>
              <Text style={s.rowText}>{school.schoolName ?? 'Your school'}</Text>
              <Text style={s.rowArrow}>›</Text>
            </Pressable>
          ))}
          <Button label="Sign out" quiet onPress={() => void signOut()} />
        </View>
      );
      break;
    case 'home': {
      const schools = view.schools;
      body = (
        <View style={s.stack}>
          <View style={s.topRow}>
            <Image source={require('../assets/hon-mark.png')} style={s.mark} accessibilityLabel="HON" />
            {schools ? <Pill label="Switch school" onPress={() => setView({ kind: 'choose', schools })} /> : null}
          </View>
          <Text style={s.kicker}>Signed in</Text>
          <Text style={s.hero}>{view.school.schoolName ?? 'Your school'}</Text>
          <View style={[s.warmCard, { backgroundColor: T.orbit.cyan }]}>
            <Text style={s.warmTitle}>Coming next</Text>
            <Text style={s.warmBody}>Today's classes, check-in, HON and Kai are coming in the next updates of this app.</Text>
          </View>
          <View style={s.panel}>
            <Text style={s.panelTitle}>HON and your AI team</Text>
            <Text style={s.panelBody}>Your owner chooses which AI team members you can use. They will appear here.</Text>
          </View>
          <Button label="Sign out" quiet onPress={() => void signOut()} />
        </View>
      );
      break;
    }
  }
  return (
    <ScrollView contentContainerStyle={s.screen}>
      {body}
      <Text style={s.version}>HON Staff {version}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: { flexGrow: 1, justifyContent: 'center', padding: 20, backgroundColor: T.paper },
  stack: { gap: 16 },
  card: { backgroundColor: T.card, borderRadius: T.radius.card, padding: 22, gap: 14, borderWidth: 1, borderColor: T.line },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mark: { width: 44, height: 44 },
  kicker: { color: T.muted, fontSize: 13, fontWeight: '600', letterSpacing: 1, textTransform: 'uppercase', marginTop: 12 },
  hero: { color: T.ink, fontFamily: T.serif, fontSize: 34, lineHeight: 40 },
  title: { color: T.ink, fontFamily: T.serif, fontSize: 28, lineHeight: 34 },
  body: { color: T.muted, fontSize: 16, lineHeight: 23 },
  alert: { color: T.alert, fontSize: 15 },
  button: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 15, alignItems: 'center' },
  buttonText: { color: T.pillText, fontSize: 16, fontWeight: '700' },
  quiet: { backgroundColor: T.card, borderWidth: 1, borderColor: T.line },
  quietText: { color: T.ink },
  pill: { backgroundColor: T.pill, borderRadius: T.radius.pill, paddingVertical: 9, paddingHorizontal: 16 },
  pillText: { color: T.pillText, fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: T.soft, borderRadius: 16, paddingVertical: 16, paddingHorizontal: 18 },
  rowText: { color: T.ink, fontSize: 17, fontWeight: '600', flexShrink: 1 },
  rowArrow: { color: T.muted, fontSize: 24 },
  warmCard: { borderRadius: T.radius.card, padding: 22, gap: 8 },
  warmTitle: { color: T.ink, fontFamily: T.serif, fontSize: 24 },
  warmBody: { color: T.ink, fontFamily: T.serif, fontSize: 17, lineHeight: 24 },
  panel: { backgroundColor: T.panel, borderRadius: T.radius.card, padding: 22, gap: 8 },
  panelTitle: { color: T.panelText, fontSize: 18, fontWeight: '700' },
  panelBody: { color: T.panelMuted, fontSize: 15, lineHeight: 21 },
  version: { color: T.muted, fontSize: 12, textAlign: 'center', marginTop: 16 },
});
