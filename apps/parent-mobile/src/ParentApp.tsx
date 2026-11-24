import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './ui/text';
import { createNavigationContainerRef, NavigationContainer, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ParentApi } from './api/client';
import type { SessionStore } from './session/session-store';
import { FamilyProvider, useFamily } from './family/family-data';
import { registerPhone, unregisterPhone, type PhonePush } from './push/push';
import { HomeScreen } from './screens/HomeScreen';
import { ScheduleScreen, SignInScreen } from './screens/OtherTabs';
import { EianScreen } from './eian/EianScreen';
import { EianVoiceContext, type EianVoice } from './eian/voice';
import { createNaturalEianVoice, type ClipPlayer } from './eian/natural-voice';
import { MoreScreen, type Area as MoreArea } from './more/MoreScreen';
import { MessagesScreen } from './messages/MessagesScreen';
import { Loading } from './ui/parts';
import { Icon, type IconName } from './ui/icons';
import { eianImage } from './eian/avatar';
import { radius, space, type, useColors } from './ui/theme';

type Tabs = { Home: undefined; Schedule: undefined; Eian: undefined; Messages: undefined; More: { area?: MoreArea; at?: number } | undefined };
const Tab = createBottomTabNavigator<Tabs>();
const ICONS: Record<Exclude<keyof Tabs, 'Eian'>, IconName> = { Home: 'home', Schedule: 'schedule', Messages: 'messages', More: 'more' };

export interface ParentAppProps {
  api: ParentApi;
  session: Pick<SessionStore, 'token' | 'clear' | 'subscribe'>;
  now?: () => Date;
  version?: string;
  /** Native sign-in (M2). Omitted in builds where sign-in is not configured. */
  onSignIn?: () => Promise<'signed-in' | 'cancelled' | 'failed'>;
  /** Random Idempotency-Key source (expo-crypto randomUUID in the app). */
  newKey?: () => string;
  /** Test builds only: a made-up offline family to tap through before signing in. Never offered in store builds. */
  sampleApi?: () => ParentApi;
  /** Announcement notifications on this phone (0601). Omitted where the phone cannot receive them. */
  push?: PhonePush | null;
  /** Eian's voice from the phone; without it Eian is text only. */
  voice?: EianVoice | null;
  /** Plays Eian's natural voice clips; without it the phone's own voice reads every answer. */
  clipPlayer?: ClipPlayer | null;
}

export function ParentApp({ api, session, now = () => new Date(), version = '0.1.0', onSignIn, newKey = missingKeySource, sampleApi, push, voice = null, clipPlayer = null }: ParentAppProps) {
  const [sample, setSample] = useState<ParentApi | null>(null);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void session.token().then(t => { if (live) setToken(t); });
    const off = session.subscribe(t => setToken(t));
    return () => { live = false; off(); };
  }, [session]);
  // Sign out first tells the server to stop notifications to this phone (best effort, a few seconds at most).
  const signOut = useCallback(() => {
    void (async () => { if (push) await unregisterPhone(api, push, newKey); await session.clear(); })();
  }, [session, api, push, newKey]);
  // Signed in for real (never the sample family): ask once per sign-in to show the school's announcements on this phone.
  const signedIn = typeof token === 'string' && token.length > 0;
  const latest = useRef({ api, newKey });
  latest.current = { api, newKey };
  useEffect(() => { if (signedIn && push) void registerPhone(latest.current.api, push, latest.current.newKey); }, [signedIn, token, push]);
  // Tapping an announcement notification opens Home and reads the latest.
  const [opened, setOpened] = useState(0);
  useEffect(() => (signedIn && push ? push.onOpenAnnouncement(() => setOpened(n => n + 1)) : undefined), [signedIn, push]);

  // Eian's natural voice sits in front of the phone's own voice and talks to whichever family is on screen (the sample
  // family's API never reaches the speech service). Signed out, every request is refused and the phone's voice reads.
  const current = useRef<ParentApi>(api);
  current.current = sample ?? api;
  const eianVoice = useMemo(() => (voice && clipPlayer
    ? createNaturalEianVoice({ api: () => current.current, phone: voice, player: clipPlayer, newKey: () => latest.current.newKey() }) : voice), [voice, clipPlayer]);

  return (
    <EianVoiceContext.Provider value={eianVoice}>
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      {token === undefined ? <Loading label="Starting HON" />
        : sample ? (
          <View style={{ flex: 1 }}>
            <SampleBanner onExit={() => setSample(null)} />
            <FamilyProvider key="sample" api={sample} onSignedOut={() => setSample(null)} now={now} newKey={newKey}>
              <Tabs onSignOut={() => setSample(null)} version={version} />
            </FamilyProvider>
          </View>
        )
        : token === null ? <SignInScreen onSignIn={onSignIn} onTrySample={sampleApi ? () => setSample(sampleApi()) : undefined} />
        : (
          // Keyed by session so nothing from a previous sign-in survives into the next one.
          <FamilyProvider key={token} api={api} onSignedOut={signOut} now={now} newKey={newKey}>
            <Tabs onSignOut={signOut} version={version} opened={opened} />
          </FamilyProvider>
        )}
    </SafeAreaProvider>
    </EianVoiceContext.Provider>
  );
}

function Tabs({ onSignOut, version, opened = 0 }: { onSignOut: () => void; version: string; opened?: number }) {
  const navigation = useState(() => createNavigationContainerRef<Tabs>())[0];
  const { refresh } = useFamily();
  useEffect(() => {
    if (!opened) return;
    if (navigation.isReady()) navigation.navigate('Home');
    refresh();
  }, [opened, navigation, refresh]);
  return (
    <NavigationContainer ref={navigation}>
      <Tab.Navigator screenOptions={{ headerShown: false }} tabBar={props => <TabBar {...props} />}>
        <Tab.Screen name="Home" children={() => <HomeFromTab />} />
        <Tab.Screen name="Schedule" component={ScheduleScreen} />
        <Tab.Screen name="Eian" children={() => <EianFromTab />} />
        <Tab.Screen name="Messages" component={MessagesScreen} />
        <Tab.Screen name="More" children={() => <MoreFromTab onSignOut={onSignOut} version={version} />} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

/** Always visible while the made-up family is shown, so a sample is never mistaken for a real school's records. */
function SampleBanner({ onExit }: { onExit: () => void }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="alert" accessibilityLabel="Sample family. Made-up data, not a real school." style={{ backgroundColor: c.warning, paddingTop: insets.top + space.xs, paddingBottom: space.xs, paddingHorizontal: space.lg, flexDirection: 'row', alignItems: 'center' }}>
      <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={{ flex: 1, color: '#FFFFFF', fontWeight: '800', fontSize: type.caption }}>SAMPLE FAMILY · made-up data</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Exit sample" onPress={onExit} style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: space.sm }}>
        <Text style={{ color: '#FFFFFF', fontWeight: '800', textDecorationLine: 'underline' }}>Exit</Text>
      </Pressable>
    </View>
  );
}

function missingKeySource(): string { throw new Error('No Idempotency-Key source configured.'); }

function EianFromTab() {
  const navigation = useNavigation<{ navigate: (tab: keyof Tabs) => void }>();
  const [focusTick, setFocusTick] = useState(0);
  const [active, setActive] = useState(false);
  useFocusEffect(useCallback(() => { setFocusTick(n => n + 1); setActive(true); return () => setActive(false); }, []));
  return <EianScreen onNavigate={tab => navigation.navigate(tab)} focusTick={focusTick} active={active} />;
}

function HomeFromTab() {
  const navigation = useNavigation<{ navigate: (tab: keyof Tabs, params?: Tabs['More']) => void }>();
  return <HomeScreen onNavigate={tab => navigation.navigate(tab)}
    onJourneyGo={go => go.tab === 'More' ? navigation.navigate('More', { area: go.area, at: Date.now() }) : navigation.navigate('Messages')} />;
}

/** More opens straight into an area when Home's journey sends it there (`at` makes a repeat tap open it again). */
function MoreFromTab({ onSignOut, version }: { onSignOut: () => void; version: string }) {
  const route = useRoute<{ key: string; name: 'More'; params: Tabs['More'] }>();
  return <MoreScreen onSignOut={onSignOut} version={version} openArea={route.params?.area ?? null} openAt={route.params?.at ?? 0} />;
}

/** Five fixed tabs; Eian's face is the raised center tab. Every tab is a 48pt+ target with a screen-reader role. */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {state.routes.map((route, index) => {
        const name = route.name as keyof Tabs;
        const focused = state.index === index;
        const color = name === 'Eian' ? (focused ? c.glowEdge : c.subtle) : focused ? c.accent : c.subtle;
        return (
          <Pressable key={route.key} accessibilityRole="tab" accessibilityLabel={name} accessibilityState={{ selected: focused }}
            onPress={() => { if (!focused) navigation.navigate(route.name); }} style={styles.item}>
            {name === 'Eian' ? (
              <View style={[styles.face, { borderColor: c.surface, backgroundColor: c.glow, shadowColor: c.glowEdge }]}>
                <View style={[styles.faceRing, { borderColor: c.glow, borderBottomColor: c.glowEdge }]}>
                  <Image source={eianImage('chibi', 'ready')} style={styles.faceImage} accessibilityIgnoresInvertColors />
                </View>
              </View>
            ) : (
              <View style={[styles.tile, focused ? { backgroundColor: c.accentSoft, borderColor: c.accent } : { borderColor: 'transparent' }]}>
                <Icon name={ICONS[name]} size={24} color={color} />
              </View>
            )}
            <Text maxFontSizeMultiplier={1.3} style={{ color, fontSize: type.caption - 1, fontWeight: focused ? '800' : '700', marginTop: 3 }}>{name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 2, paddingTop: space.sm },
  item: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'flex-end' },
  tile: { width: 46, height: 36, borderRadius: radius.sm, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  face: { width: 64, height: 64, borderRadius: radius.pill, borderWidth: 3, marginTop: -28, overflow: 'visible', elevation: 4, shadowOpacity: 0.35, shadowRadius: 0, shadowOffset: { width: 0, height: 4 } },
  faceRing: { flex: 1, borderRadius: radius.pill, borderWidth: 3, borderBottomWidth: 5, overflow: 'hidden' },
  faceImage: { width: '100%', height: '130%' },
});
