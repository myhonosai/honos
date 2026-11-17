import React, { useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import appConfig from './app.json';
import { createParentApi } from './src/api/client';
import { createSessionStore } from './src/session/session-store';
import { base64url, pkceChallenge } from './src/session/pkce';
import { signIn } from './src/session/sign-in';
import { ParentApp } from './src/ParentApp';

const session = createSessionStore();
const API = process.env.EXPO_PUBLIC_HON_API_URL ?? '';
const WEB = process.env.EXPO_PUBLIC_HON_WEB_URL ?? '';

function webOrigin(raw: string): string | null {
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '10.0.2.2';
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || /REPLACE-WITH/i.test(raw)) return null;
    return url.origin;
  } catch { return null; }
}

export default function App() {
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
    apiBaseUrl: new URL(API).origin,
    randomVerifier: async () => base64url(Crypto.getRandomBytes(32)),
    challengeFor: verifier => pkceChallenge(verifier, data => Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, data)),
    // Ephemeral: the browser keeps no HON web session or cookies after handing the code back.
    openAuthSession: (url, returnUrl) => WebBrowser.openAuthSessionAsync(url, returnUrl, { preferEphemeralSession: true }),
    fetchImpl: fetch,
    saveToken: token => session.save(token),
  }) : undefined;
  return (
    <>
      <StatusBar style="auto" />
      <ParentApp api={api} session={session} version={appConfig.expo.version} onSignIn={onSignIn} newKey={() => Crypto.randomUUID()} />
    </>
  );
}
