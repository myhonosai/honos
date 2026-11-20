import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createNavigationContainerRef, NavigationContainer, useFocusEffect, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ParentApi } from './api/client';
import type { SessionStore } from './session/session-store';
import { FamilyProvider, useFamily } from './family/family-data';
import { registerPhone, unregisterPhone, type PhonePush } from './push/push';
import { HomeScreen } from './screens/HomeScreen';
import { ScheduleScreen, SignInScreen } from './screens/OtherTabs';
import { EianScreen } from './eian/EianScreen';
import { MoreScreen } from './more/MoreScreen';
import { MessagesScreen } from './messages/MessagesScreen';
import { Loading } from './ui/parts';
import { radius, space, type, useColors } from './ui/theme';

type Tabs = { Home: undefined; Schedule: undefined; Eian: undefined; Messages: undefined; More: undefined };
const Tab = createBottomTabNavigator<Tabs>();
const ICONS: Record<keyof Tabs, string> = { Home: '⌂', Schedule: '▦', Eian: '✦', Messages: '✉', More: '☰' };

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
}

export function ParentApp({ api, session, now = () => new Date(), version = '0.1.0', onSignIn, newKey = missingKeySource, sampleApi, push }: ParentAppProps) {
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

  return (
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
        <Tab.Screen name="More" children={() => <MoreScreen onSignOut={onSignOut} version={version} />} />
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
  useFocusEffect(useCallback(() => { setFocusTick(n => n + 1); }, []));
  return <EianScreen onNavigate={tab => navigation.navigate(tab)} focusTick={focusTick} />;
}

function HomeFromTab() {
  const navigation = useNavigation<{ navigate: (tab: keyof Tabs) => void }>();
  return <HomeScreen onNavigate={tab => navigation.navigate(tab)} />;
}

/** Five fixed tabs; Eian is the raised center action. Every tab is a 48pt+ target with a screen-reader role. */
function TabBar({ state, navigation }: BottomTabBarProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {state.routes.map((route, index) => {
        const name = route.name as keyof Tabs;
        const focused = state.index === index;
        const center = name === 'Eian';
        const color = focused ? c.accent : c.subtle;
        return (
          <Pressable key={route.key} accessibilityRole="tab" accessibilityLabel={name} accessibilityState={{ selected: focused }}
            onPress={() => { if (!focused) navigation.navigate(route.name); }} style={styles.item}>
            {center ? (
              <View style={[styles.center, { backgroundColor: c.accent, shadowColor: c.glow }]}>
                <Text style={{ color: c.accentText, fontSize: 24 }}>{ICONS[name]}</Text>
              </View>
            ) : <Text style={{ color, fontSize: 20 }}>{ICONS[name]}</Text>}
            <Text maxFontSizeMultiplier={1.3} style={{ color, fontSize: type.caption - 1, fontWeight: focused ? '800' : '600', marginTop: center ? 2 : 4 }}>{name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.sm },
  item: { flex: 1, minHeight: 52, alignItems: 'center', justifyContent: 'flex-end' },
  center: { width: 58, height: 58, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', marginTop: -26, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6 },
});
