import React, { useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import appConfig from './app.json';
import { checkedBaseUrl, createParentApi } from './src/api/client';
import { createSessionStore } from './src/session/session-store';
import { base64url, pkceChallenge } from './src/session/pkce';
import { signIn } from './src/session/sign-in';
import { ParentApp } from './src/ParentApp';
import { createSampleApi } from './src/sample/sample-api';
import { createExpoPhonePush } from './src/push/expo-push';
import { createExpoEianVoice } from './src/eian/expo-voice';
import { createExpoClipPlayer } from './src/eian/expo-clip-player';
import { useFonts, Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black } from '@expo-google-fonts/nunito';
import { FontsReadyProvider } from './src/ui/text';

const session = createSessionStore();
const API = process.env.EXPO_PUBLIC_HON_API_URL ?? '';
const WEB = process.env.EXPO_PUBLIC_HON_WEB_URL ?? '';
// Test builds only (eas.json preview/development). Store builds never offer the made-up sample family.
const SAMPLE = process.env.EXPO_PUBLIC_HON_SAMPLE_MODE === '1';
// Announcement notifications (0601): the phone registers on sign-in; nothing is sent until the school server is approved to send.
const PUSH = createExpoPhonePush(appConfig.expo.extra.eas.projectId);
const VOICE = createExpoEianVoice();
// Eian's natural voice (0638): plays a clip HON makes when the school has it on; otherwise the phone's own voice reads.
const CLIPS = createExpoClipPlayer();

function webOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '10.0.2.2';
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || /REPLACE-WITH/i.test(raw)) return null;
    return url.origin;
  } catch { return null; }
}

export default function App() {
  // Nunito ships inside the app (SIL OFL). If it fails to load, the system font is used; the app never waits on the network.
  const [fontsLoaded, fontError] = useFonts({ Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black });
  const api = useMemo(() => {
    try { return createParentApi({ baseUrl: API, getToken: () => session.token() }); }
    catch { return null; }
  }, []);
  const web = webOrigin(WEB);
  if (!api) {
    // A build without a valid https API address must not start at all rather than talk to the wrong server.
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}><Text>This build of HON Family is not configured. Please update the app.</Text></View>;
  }
  const onSignIn = web ? () => signIn({
    webOrigin: web,
    // Same base as every read, path included: the web only forwards /api/v1/* to the API.
    apiBaseUrl: checkedBaseUrl(API),
    randomVerifier: async () => base64url(Crypto.getRandomBytes(32)),
    challengeFor: verifier => pkceChallenge(verifier, data => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data)),
    // Ephemeral: the browser keeps no HON web session or cookies after handing the code back.
    openAuthSession: (url, returnUrl) => WebBrowser.openAuthSessionAsync(url, returnUrl, { preferEphemeralSession: true }),
    fetchImpl: fetch,
    saveToken: token => session.save(token),
  }) : undefined;
  if (!fontsLoaded && !fontError) return null;
  return (
    <FontsReadyProvider value={fontsLoaded}>
      <StatusBar style="auto" />
      <ParentApp api={api} session={session} version={appConfig.expo.version} onSignIn={onSignIn} sampleApi={SAMPLE ? () => createSampleApi() : undefined} newKey={() => Crypto.randomUUID()} push={PUSH} voice={VOICE} clipPlayer={CLIPS} />
    </FontsReadyProvider>
  );
}
