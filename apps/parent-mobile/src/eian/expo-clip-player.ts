import { Platform } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { ClipPlayer } from './natural-voice';

let counter = 0;
/**
 * Plays one of Eian's voice clips on the phone. The clip is put in the app's private cache only while it plays and is
 * deleted when it ends, is stopped or cannot play; it is never saved, shared or uploaded.
 */
export function createExpoClipPlayer(): ClipPlayer | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  return {
    play(base64Mp3, onDone) {
      let over = false;
      let file: File | null = null;
      let player: ReturnType<typeof createAudioPlayer> | null = null;
      let subscription: { remove(): void } | null = null;
      const finish = (finished: boolean) => {
        if (over) return;
        over = true;
        try { subscription?.remove(); } catch { /* gone */ }
        try { player?.pause(); } catch { /* gone */ }
        try { player?.remove(); } catch { /* gone */ }
        try { if (file?.exists) file.delete(); } catch { /* the cache is cleared by the phone */ }
        onDone(finished);
      };
      try {
        counter += 1;
        file = new File(Paths.cache, `eian-voice-${Date.now()}-${counter}.mp3`);
        file.create({ overwrite: true });
        file.write(base64Mp3, { encoding: 'base64' });
        // Eian answers a parent who asked to hear it, so it plays even when the ringer switch is on silent.
        void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
        player = createAudioPlayer({ uri: file.uri });
        subscription = player.addListener('playbackStatusUpdate', status => { if (status.didJustFinish) finish(true); });
        player.play();
      } catch { finish(false); }
      return { stop() { finish(false); } };
    },
  };
}
