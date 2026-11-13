'use client';
/**
 * Voice typing (ADR 0012): the browser's own speech recognition (Chrome, Edge, Safari; not
 * Firefox). Note: in Chrome the audio is turned into text by Google's speech service.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface Rec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function recognizer(): (new () => Rec) | null {
  const w = globalThis as unknown as { SpeechRecognition?: new () => Rec; webkitSpeechRecognition?: new () => Rec };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Voice languages: Indian English by default; kept in this browser. */
export const VOICE_LANGS: [string, string][] = [['en-IN', 'English (India)'], ['hi-IN', 'हिन्दी (Hindi)'], ['mr-IN', 'मराठी (Marathi)'], ['en-US', 'English (US)']];
export function voiceLang(): string {
  try {
    return localStorage.getItem('magnus.voiceLang') ?? 'en-IN';
  } catch {
    return 'en-IN';
  }
}
export function setVoiceLang(l: string): void {
  try {
    localStorage.setItem('magnus.voiceLang', l);
  } catch {
    // private mode: this visit only
  }
}

const WHY: Record<string, string> = {
  'not-allowed': 'Microphone blocked: allow it for this site in the browser.',
  'service-not-allowed': 'Microphone blocked: allow it for this site in the browser.',
  'no-speech': 'Nothing heard. Tap the mic and speak again.',
  'audio-capture': 'No microphone found.',
  network: 'Speech recognition needs an internet connection.',
};

/**
 * Speech to text into a text field. `append` gets each finished sentence; `interim` is the
 * part still being recognised.
 */
export function useVoice(append: (text: string) => void): { supported: boolean; listening: boolean; interim: string; error: string | null; toggle: () => void } {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Rec | null>(null);
  const add = useRef(append);
  add.current = append;

  useEffect(() => {
    setSupported(recognizer() !== null);
    return () => rec.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (rec.current) {
      rec.current.stop();
      return;
    }
    const R = recognizer();
    if (!R) return;
    const r = new R();
    r.lang = voiceLang();
    // Android Chrome repeats earlier words in continuous mode: there, one phrase per tap.
    r.continuous = !/Android/i.test(navigator.userAgent);
    r.interimResults = true;
    let added = '';
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) {
          const t = res[0].transcript.trim();
          if (t === '' || t === added) continue;
          added = t;
          add.current(t);
        } else live += res[0].transcript;
      }
      setInterim(live);
    };
    r.onerror = (e) => setError(WHY[e.error] ?? `Voice stopped: ${e.error}`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim('');
    };
    setError(null);
    rec.current = r;
    r.start();
    setListening(true);
  }, []);

  return { supported, listening, interim, error, toggle };
}
