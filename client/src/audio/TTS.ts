/**
 * TTS: Speech Synthesis Utility for Rest-In-Hackaton.
 * Synthesizes Chinese Mandarin (zh-CN) pronunciation for learned vocabulary.
 * Gracefully degrades in headless / non-browser environments without throwing errors.
 */

export class TTS {
  private static endpoint: string | null = null;
  private static audio: HTMLAudioElement | null = null;
  private static audioUrl: string | null = null;
  private static generation = 0;

  public static useMiddleware(endpoint: string | null): void { TTS.stop(); TTS.endpoint = endpoint; }

  private static async playMiddleware(text: string, generation: number): Promise<void> {
    try {
      const response = await fetch(`${TTS.endpoint}?${new URLSearchParams({ text })}`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
      const blob = await response.blob();
      if (generation !== TTS.generation) return;
      TTS.audioUrl = URL.createObjectURL(blob);
      TTS.audio = new Audio(TTS.audioUrl);
      TTS.audio.onended = () => TTS.stop();
      await TTS.audio.play();
    } catch {
      if (generation !== TTS.generation) return;
      TTS.stop();
      TTS.speakNative(text);
    }
  }

  /**
   * Returns true if speech synthesis is supported in the current environment.
   */
  public static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      'speechSynthesis' in window &&
      typeof (window as any).SpeechSynthesisUtterance !== 'undefined' &&
      Boolean(window.speechSynthesis) &&
      typeof window.speechSynthesis.speak === 'function'
    );
  }

  /**
   * Speaks the provided Chinese text in Mandarin (zh-CN) at 0.9x rate.
   * Returns true on successful dispatch, or false if unsupported / failed.
   */
  public static speakZh(text: string): boolean {
    if (!text || typeof text !== 'string') {
      return false;
    }

    if (TTS.endpoint && typeof Audio !== 'undefined') {
      TTS.stop();
      void TTS.playMiddleware(text, TTS.generation);
      return true;
    }
    return TTS.speakNative(text);
  }

  private static speakNative(text: string): boolean {
    if (!TTS.isSupported()) return false;

    try {
      const utterance = new window.SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (err) {
      console.warn('[TTS] SpeechSynthesis failed:', err);
      return false;
    }
  }

  /**
   * Cancels any active speech synthesis output.
   */
  public static stop(): void {
    TTS.generation++;
    TTS.audio?.pause();
    TTS.audio = null;
    if (TTS.audioUrl) URL.revokeObjectURL(TTS.audioUrl);
    TTS.audioUrl = null;
    if (TTS.isSupported()) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Safe no-op
      }
    }
  }
}

export const speakZh = TTS.speakZh;
