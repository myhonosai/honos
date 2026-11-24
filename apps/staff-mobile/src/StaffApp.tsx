import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { StaffApi, StaffFailureState, StaffSchool } from './api/client';
import type { SessionStore } from './session/session-store';
import { Hon } from './Hon';
import { People } from './People';
import { Texts } from './Texts';
import { Today } from './Today';
import { T } from './ui/theme';

type SignInResult = 'signed-in' | 'cancelled' | 'failed';
export interface StaffAppProps {
  api: StaffApi;
  session: Pick<SessionStore, 'token' | 'clear' | 'subscribe'>;
  /** Absent when this build has no valid HON web address: the app then cannot sign in at all. */
  onSignIn?: () => Promise<SignInResult>;
  version: string;
  /** A fresh idempotency key (a UUID) for each new command. */
  newKey: () => string;
}

type View_ =
  | { kind: 'loading' }
  | { kind: 'signed-out'; message?: string }
  | { kind: 'failed'; state: Exclude<StaffFailureState, 'signed-out'> }
  | { kind: 'choose'; schools: StaffSchool[]; generation: number }
  | { kind: 'home'; school: StaffSchool; schools: StaffSchool[] | null; generation: number; tab: Tab };
type Tab = 'today' | 'people' | 'hon' | 'texts';
const TABS: { tab: Tab; label: string; kicker: string }[] = [
  { tab: 'today', label: 'Today', kicker: 'Today' }, { tab: 'people', label: 'People', kicker: 'People' },
  { tab: 'hon', label: 'HON', kicker: 'Ask HON' }, { tab: 'texts', label: 'Texts', kicker: 'Texts' },
];


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
 * S0b/S1/S2/S4: sign in, find the school the person works at (choose when there are several), then Today, People,
 * HON and Texts. The chosen school lives only in memory: it is where the app will look, never permission. Later
 * phases add Kai's journal and Me.
 */
export function StaffApp({ api, session, onSignIn, version, newKey }: StaffAppProps) {
  const [view, setView] = useState<View_>({ kind: 'loading' });
  /**
   * Session ownership. Every sign-out and every (re)load starts a new generation, and the screens of one generation
   * may only end their own generation. A slow request started under session A that answers 401 after the person
   * signed out and back in as B therefore cannot wipe B's session (security review 2026-11-22, staff mobile).
   */
  const generation = useRef(0);
  const next = () => ++generation.current;

  const load = useCallback(async () => {
    const mine = next();
    setView({ kind: 'loading' });
    const token = await session.token();
    if (mine !== generation.current) return;
    if (!token) { setView({ kind: 'signed-out' }); return; }
    const result = await api.whereIWork();
    if (mine !== generation.current) return;
    if (!result.ok) {
      if (result.state === 'signed-out') { next(); await session.clear(); setView({ kind: 'signed-out' }); return; }
      setView({ kind: 'failed', state: result.state });
      return;
    }
    setView(result.data.kind === 'one'
      ? { kind: 'home', school: result.data.school, schools: null, generation: mine, tab: 'today' }
      : { kind: 'choose', schools: result.data.schools, generation: mine });
  }, [api, session]);

  useEffect(() => { void load(); }, [load]);

  const signIn = async () => {
    if (!onSignIn) return;
    const outcome = await onSignIn();
    if (outcome === 'signed-in') await load();
    else setView({ kind: 'signed-out', message: outcome === 'failed' ? 'Sign-in did not finish. Please try again.' : undefined });
  };
  const signOut = async () => { next(); await session.clear(); setView({ kind: 'signed-out' }); };
  /** "Your session ended", bound to one generation: a no-op once that generation is over. */
  const endedFor = useCallback((owner: number) => () => {
    if (owner !== generation.current) return;
    next();
    void session.clear().then(() => setView({ kind: 'signed-out', message: 'Your session ended. Please sign in again.' }));
  }, [session]);
  const homeGeneration = view.kind === 'home' ? view.generation : -1;
  const ended = useMemo(() => endedFor(homeGeneration), [endedFor, homeGeneration]);

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
              onPress={() => setView({ kind: 'home', school, schools: view.schools, generation: view.generation, tab: 'today' })}>
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
            {schools ? <Pill label="Switch school" onPress={() => setView({ kind: 'choose', schools, generation: view.generation })} /> : null}
          </View>
          <View style={s.tabs} accessibilityRole="tablist">
            {TABS.map(({ tab, label }) => (
              <Pressable key={tab} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: view.tab === tab }}
                onPress={() => setView({ ...view, tab })} style={[s.tab, view.tab === tab && s.tabOn]}>
                <Text style={[s.tabText, view.tab === tab && s.tabTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.kicker}>{TABS.find(t => t.tab === view.tab)!.kicker}</Text>
          <Text style={s.hero}>{view.school.schoolName ?? 'Your school'}</Text>
          {view.tab === 'today' ? <Today key={`${view.generation}:${view.school.schoolId}`} api={api} school={view.school} newKey={newKey} onSignedOut={ended} /> : null}
          {view.tab === 'people' ? <People key={`${view.generation}:${view.school.schoolId}`} api={api} school={view.school} onSignedOut={ended} /> : null}
          {view.tab === 'hon' ? <Hon key={`${view.generation}:${view.school.schoolId}`} api={api} school={view.school} newKey={newKey} onSignedOut={ended} /> : null}
          {view.tab === 'texts' ? <Texts key={`${view.generation}:${view.school.schoolId}`} api={api} school={view.school} newKey={newKey} onSignedOut={ended} /> : null}
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
  tabs: { flexDirection: 'row', backgroundColor: T.soft, borderRadius: T.radius.pill, padding: 4, gap: 4 },
  tab: { flex: 1, alignItems: 'center', borderRadius: T.radius.pill, paddingVertical: 10 },
  tabOn: { backgroundColor: T.pill },
  tabText: { color: T.ink, fontSize: 15, fontWeight: '700' },
  tabTextOn: { color: T.pillText },
  version: { color: T.muted, fontSize: 12, textAlign: 'center', marginTop: 16 },
});
