import React from 'react';
import { Image, Modal, StyleSheet, View } from 'react-native';
import { Text } from './text';
import { Button } from './parts';
import { eianImage } from '../eian/avatar';
import { radius, space, type, useColors } from './theme';

const CONFETTI = ['#FF6F55', '#8FD61F', '#2F7BFF', '#FFC23D', '#8B6CFF', '#25C9DE', '#E8478D'];

/**
 * The reward moment. Shown only after the school's server confirmed a booking (never for a waitlist place, an unknown
 * result or a refusal). It repeats what the server returned; it never adds facts of its own.
 */
export function Celebration({ visible, title, detail, onClose }: { visible: boolean; title: string; detail: string; onClose: () => void }) {
  const c = useColors();
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: c.bg }]} accessibilityViewIsModal>
        <View style={styles.confetti} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {CONFETTI.map((color, i) => <View key={i} style={[styles.bit, { backgroundColor: color, left: `${8 + i * 13}%`, top: 40 + (i % 3) * 46, transform: [{ rotate: `${i * 37}deg` }] }]} />)}
        </View>
        <View style={[styles.ring, { borderColor: c.glow, borderBottomColor: c.glowEdge }]}>
          <Image source={eianImage('chibi', 'speaking')} style={styles.face} accessibilityIgnoresInvertColors />
        </View>
        <Text accessibilityRole="header" style={{ color: c.success, fontSize: 30, fontWeight: '900', marginTop: space.xl, textAlign: 'center' }}>{title}</Text>
        <Text style={{ color: c.text, fontSize: type.title - 2, fontWeight: '700', marginTop: space.sm, textAlign: 'center' }}>{detail}</Text>
        <View style={{ alignSelf: 'stretch', marginTop: space.xxl }}><Button kind="go" label="Continue" onPress={onClose} /></View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  bit: { position: 'absolute', width: 14, height: 7, borderRadius: 4 },
  ring: { width: 176, height: 176, borderRadius: radius.pill, borderWidth: 6, borderBottomWidth: 12, overflow: 'hidden' },
  face: { width: '100%', height: '125%' },
});
