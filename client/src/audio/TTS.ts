/**
 * TTS: Speech Synthesis Utility for Rest-In-Hackaton.
 * Synthesizes Chinese Mandarin (zh-CN) pronunciation for learned vocabulary.
 * Gracefully degrades in headless / non-browser environments without throwing errors.
 */

export class TTS {
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

    if (!TTS.isSupported()) {
      return false;
    }

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
