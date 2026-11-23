import React, { createContext, useContext } from 'react';
import { StyleSheet, Text as NativeText, type TextProps, type TextStyle } from 'react-native';

/**
 * HON Family text. When the Nunito family has loaded (App.tsx), each weight maps to its own font file, because custom
 * fonts on Android ignore fontWeight. Before the fonts load, or when they fail to load, the system font is used.
 */
export const FONT_FILES = {
  '400': 'Nunito_400Regular', '500': 'Nunito_600SemiBold', '600': 'Nunito_700Bold', '700': 'Nunito_800ExtraBold', '800': 'Nunito_900Black', '900': 'Nunito_900Black',
} as const;
type Weight = keyof typeof FONT_FILES;

const FontsReady = createContext(false);
export const FontsReadyProvider = FontsReady.Provider;

export function fontFor(weight: TextStyle['fontWeight']): string {
  const key = String(weight ?? '400').replace('normal', '400').replace('bold', '700') as Weight;
  return FONT_FILES[key] ?? FONT_FILES['400'];
}

export function Text({ style, ...rest }: TextProps) {
  const ready = useContext(FontsReady);
  if (!ready) return <NativeText style={style} {...rest} />;
  const flat = StyleSheet.flatten(style) ?? {};
  if (flat.fontFamily) return <NativeText style={style} {...rest} />;
  const { fontWeight, ...without } = flat;
  return <NativeText style={[without, { fontFamily: fontFor(fontWeight) }]} {...rest} />;
}
