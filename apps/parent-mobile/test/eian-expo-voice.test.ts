import { createExpoEianVoice } from '../src/eian/expo-voice';
import type { HeardResult } from '../src/eian/voice';

type Listener = (event: unknown) => void;
type MockRecognition = {
  granted: boolean; listeners: Map<string, Listener>; removed: number;
  requestPermissionsAsync: jest.Mock; isRecognitionAvailable: jest.Mock; addListener: jest.Mock; start: jest.Mock; stop: jest.Mock; abort: jest.Mock;
};
jest.mock('expo-speech-recognition', () => {
  const module: Record<string, unknown> = { granted: true, listeners: new Map(), removed: 0, isRecognitionAvailable: jest.fn(() => true), start: jest.fn(), stop: jest.fn(), abort: jest.fn() };
  module.requestPermissionsAsync = jest.fn(async () => ({ granted: module.granted }));
  module.addListener = jest.fn((name: string, listener: unknown) => {
    (module.listeners as Map<string, unknown>).set(name, listener);
    return { remove: () => { module.removed = (module.removed as number) + 1; } };
  });
  return { ExpoSpeechRecognitionModule: module };
});
jest.mock('expo-speech', () => ({ stop: jest.fn(async () => undefined), speak: jest.fn(), maxSpeechInputLength: 4000 }));
const mockRecognition = (jest.requireMock('expo-speech-recognition') as { ExpoSpeechRecognitionModule: MockRecognition }).ExpoSpeechRecognitionModule;
const mockSpeech = jest.requireMock('expo-speech') as { stop: jest.Mock; speak: jest.Mock };

const emit = (name: string, event?: unknown) => mockRecognition.listeners.get(name)!(event);
const tick = () => new Promise<void>(resolve => setImmediate(() => resolve()));
function listen() {
  const partial: string[] = [], ended: HeardResult[] = [];
  const handle = createExpoEianVoice()!.listen({ partial: t => partial.push(t), end: r => ended.push(r) });
  return { handle, partial, ended };
}

describe('phone voice for Eian', () => {
  beforeEach(() => { jest.clearAllMocks(); mockRecognition.granted = true; mockRecognition.listeners.clear(); mockRecognition.removed = 0; });

  it('hears one short question in English and never listens continuously', async () => {
    const { handle, partial, ended } = listen();
    await tick();
    expect(mockRecognition.start).toHaveBeenCalledWith({ lang: 'en-US', interimResults: true, continuous: false, maxAlternatives: 1 });
    emit('result', { isFinal: false, results: [{ transcript: 'when is' }] });
    emit('result', { isFinal: true, results: [{ transcript: ' when is the next belt test ' }] });
    handle.stop();
    expect(mockRecognition.stop).toHaveBeenCalledTimes(1);
    emit('end');
    expect(partial).toEqual(['when is']);
    expect(ended).toEqual([{ kind: 'heard', text: 'when is the next belt test' }]);
    expect(mockRecognition.removed).toBe(3);
    emit('end');
    expect(ended).toHaveLength(1);
  });

  it('never starts the microphone when permission is refused', async () => {
    mockRecognition.granted = false;
    const { ended } = listen();
    await tick();
    expect(mockRecognition.start).not.toHaveBeenCalled();
    expect(ended).toEqual([{ kind: 'denied' }]);
  });

  it.each([['not-allowed', 'denied'], ['service-not-allowed', 'unavailable'], ['language-not-supported', 'unavailable'], ['no-speech', 'nothing']])(
    'maps the phone error %s to %s', async (error, kind) => {
      const { ended } = listen();
      await tick();
      emit('error', { error });
      emit('end');
      expect(ended).toEqual([{ kind }]);
    });

  it('cancels silently: aborts and delivers nothing', async () => {
    const { handle, ended } = listen();
    await tick();
    emit('result', { isFinal: false, results: [{ transcript: 'do we' }] });
    handle.cancel();
    expect(mockRecognition.abort).toHaveBeenCalledTimes(1);
    expect(ended).toEqual([]);
  });

  it('reads aloud with the phone voice and reports the end once', async () => {
    const done = jest.fn();
    createExpoEianVoice()!.speak('Hello there.', done);
    await tick();
    expect(mockSpeech.stop).toHaveBeenCalled();
    const [text, options] = mockSpeech.speak.mock.calls[0];
    expect([text, options.language]).toEqual(['Hello there.', 'en-US']);
    options.onStopped(); options.onDone();
    expect(done).toHaveBeenCalledTimes(1);
  });
});
