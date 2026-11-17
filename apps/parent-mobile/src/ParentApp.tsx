import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ParentApi } from './api/client';
import type { SessionStore } from './session/session-store';
import { FamilyProvider } from './family/family-data';
import { HomeScreen } from './screens/HomeScreen';
import { EianScreen, MessagesScreen, MoreScreen, ScheduleScreen, SignInScreen } from './screens/OtherTabs';
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
}

export function ParentApp({ api, session, now = () => new Date(), version = '0.1.0' }: ParentAppProps) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void session.token().then(t => { if (live) setToken(t); });
    const off = session.subscribe(t => setToken(t));
    return () => { live = false; off(); };
  }, [session]);
  const signOut = useCallback(() => { void session.clear(); }, [session]);

  return (
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      {token === undefined ? <Loading label="Starting HON" />
        : token === null ? <SignInScreen />
        : (
          // Keyed by session so nothing from a previous sign-in survives into the next one.
          <FamilyProvider key={token} api={api} onSignedOut={signOut} now={now}>
            <NavigationContainer>
              <Tab.Navigator screenOptions={{ headerShown: false }} tabBar={props => <TabBar {...props} />}>
                <Tab.Screen name="Home" children={() => <HomeFromTab />} />
                <Tab.Screen name="Schedule" component={ScheduleScreen} />
                <Tab.Screen name="Eian" component={EianScreen} />
                <Tab.Screen name="Messages" component={MessagesScreen} />
                <Tab.Screen name="More" children={() => <MoreScreen onSignOut={signOut} version={version} />} />
              </Tab.Navigator>
            </NavigationContainer>
          </FamilyProvider>
        )}
    </SafeAreaProvider>
  );
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
