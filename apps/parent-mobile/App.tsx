import React, { useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import appConfig from './app.json';
import { Text, View } from 'react-native';
import { createParentApi } from './src/api/client';
import { createSessionStore } from './src/session/session-store';
import { ParentApp } from './src/ParentApp';

const session = createSessionStore();

export default function App() {
  const api = useMemo(() => {
    try { return createParentApi({ baseUrl: process.env.EXPO_PUBLIC_HON_API_URL ?? '', getToken: () => session.token() }); }
    catch { return null; }
  }, []);
  if (!api) {
    // A build without a valid https API address must not start at all rather than talk to the wrong server.
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}><Text>This build of HON Parent is not configured. Please update the app.</Text></View>;
  }
  return (
    <>
      <StatusBar style="auto" />
      <ParentApp api={api} session={session} version={appConfig.expo.version} />
    </>
  );
}
