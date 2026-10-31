/**
 * DialogueUI: Interactive NPC Dialogue Overlay (Stage 3 & Stage 4).
 * Controls the Shenzhen Night Market dialogue overlay (#dialogue-overlay).
 * 
 * Features:
 * 1. 2-line subtitle rendering:
 *    - Line 1 (#dialogue-line-original): Chinese characters + Pinyin transcriptions.
 *    - Line 2 (#dialogue-line-translated): Russian translation with real-time [???] unmasking.
 * 2. Visual state gauges:
 *    - Respect (Mianzi): 0..100% width bar and numeric percentage label.
 *    - Rage (Aggro): 0..100% width bar and numeric percentage label.
 * 3. Interactive choices:
 *    - Up to 4 choice buttons with badge indicators [1]..[4].
 *    - Mouse click and keyboard (1..4, Digit1..Digit4, Numpad1..Numpad4) selection handlers.
 *    - Escape key closes overlay.
 * 4. Reactive lifecycle:
 *    - open(speech, onChoice, onClose, knownWords), close(), isOpen(), updateGauges(mianzi, aggro).
 *    - refreshSubtitles(knownWords): dynamic unmasking of [???] in active dialogue without restart.
 */

import { NpcSpeechPayload } from '../net/types';

export type ChoiceCallback = (choiceId: number) => void;
export type CloseCallback = () => void;

export interface DialogueUIOptions {
  rootContainer?: Document | HTMLElement | any;
  onChoice?: ChoiceCallback;
  onClose?: CloseCallback;
}

export interface IDialogueUI {
  open(
    speech: NpcSpeechPayload,
    onChoiceOrKnownWords?: ChoiceCallback | Set<string>,
    onCloseOrChoice?: CloseCallback | ChoiceCallback,
    knownWordsParam?: Set<string> | CloseCallback
  ): void;
  close(): void;
  refreshSubtitles(knownWords: Set<string>): void;
  updateGauges(mianzi: number, aggro: number): void;
  updateState(mianzi: number, aggro: number): void;
  isOpen(): boolean;
  dispose(): void;
}

export const NPC_NAMES: Record<string, string> = {
  lao_wang: 'ЛАО ВАН (老王)',
  chef_chen: 'ШЕФ ЧЭН (陈师傅)',
  guard_zhang: 'ОХРАННИК ЧЖАН (张警官)'
};

export class DialogueUI implements IDialogueUI {
  // DOM References
  private docRef: any = null;
  private overlayEl: HTMLElement | null = null;
  private npcNameEl: HTMLElement | null = null;
  private mianziFillEl: HTMLElement | null = null;
  private mianziValEl: HTMLElement | null = null;
  private aggroFillEl: HTMLElement | null = null;
  private aggroValEl: HTMLElement | null = null;
  private lineOriginalEl: HTMLElement | null = null;
  private lineTranslatedEl: HTMLElement | null = null;
  private choicesContainerEl: HTMLElement | null = null;

  // Active State
  private currentSpeech: NpcSpeechPayload | null = null;
  private onChoiceCallback: ChoiceCallback | null = null;
  private onCloseCallback: CloseCallback | null = null;
  private defaultOnChoice: ChoiceCallback | null = null;
  private defaultOnClose: CloseCallback | null = null;
  private knownWords: Set<string> = new Set<string>();

  private isOpenState = false;
  private isListeningKeys = false;
  private currentMianzi = 50;
  private currentAggro = 0;

  // Bound Event Listeners
  private boundKeyDownHandler: (e: KeyboardEvent | any) => void;

  /**
   * Initializes DialogueUI. Optionally accepts a custom root container, document,
   * or configuration object with default callbacks to facilitate headless testing environments.
   */
  constructor(rootOrOptions?: Document | HTMLElement | DialogueUIOptions | any) {
    this.boundKeyDownHandler = this.handleKeyDown.bind(this);

    if (
      rootOrOptions &&
      typeof rootOrOptions === 'object' &&
      !('getElementById' in rootOrOptions) &&
      !('querySelector' in rootOrOptions) &&
      ('onChoice' in rootOrOptions || 'onClose' in rootOrOptions || 'rootContainer' in rootOrOptions)
    ) {
      const opts = rootOrOptions as DialogueUIOptions;
      if (opts.onChoice) {
        this.defaultOnChoice = opts.onChoice;
        this.onChoiceCallback = opts.onChoice;
      }
      if (opts.onClose) {
        this.defaultOnClose = opts.onClose;
        this.onCloseCallback = opts.onClose;
      }
      this.bindDomElements(opts.rootContainer);
    } else {
      this.bindDomElements(rootOrOptions);
    }
  }

  /**
   * Binds DOM element references from either rootContainer or global document.
   */
  public bindDomElements(rootContainer?: Document | HTMLElement | any): void {
    const root = rootContainer ?? (typeof document !== 'undefined' ? document : (globalThis as any).document);
    this.docRef = root;
    if (!root) return;

    const getEl = (id: string): any => {
      if ('getElementById' in root && typeof root.getElementById === 'function') {
        return root.getElementById(id);
      }
      if ('querySelector' in root && typeof root.querySelector === 'function') {
        return root.querySelector(`#${id}`);
      }
      return null;
    };

    this.overlayEl = getEl('dialogue-overlay');
    this.npcNameEl = getEl('dialogue-npc-name');
    this.mianziFillEl = getEl('dialogue-mianzi-fill');
    this.mianziValEl = getEl('dialogue-mianzi-val');
    this.aggroFillEl = getEl('dialogue-aggro-fill');
    this.aggroValEl = getEl('dialogue-aggro-val');
    this.lineOriginalEl = getEl('dialogue-line-original');
    this.lineTranslatedEl = getEl('dialogue-line-translated');
    this.choicesContainerEl = getEl('dialogue-choices');
  }

  /**
   * Opens the dialogue overlay with speech data, wires choice and close handlers,
   * updates state gauges, renders 2-line subtitles, and binds keyboard inputs.
   * 
   * Supports both (speech, onChoice, onClose, knownWords) and (speech, knownWords, onChoice, onClose)
   * signatures for comprehensive contract compatibility.
   */
  public open(
    speech: NpcSpeechPayload,
    arg2?: ChoiceCallback | Set<string>,
    arg3?: CloseCallback | ChoiceCallback,
    arg4?: Set<string> | CloseCallback
  ): void {
    this.currentSpeech = speech;

    // Resolve polymorphic arguments
    if (typeof arg2 === 'function') {
      this.onChoiceCallback = arg2;
      this.onCloseCallback = typeof arg3 === 'function' ? (arg3 as CloseCallback) : this.defaultOnClose;
      if (arg4 instanceof Set) {
        this.knownWords = new Set(arg4);
      }
    } else if (arg2 instanceof Set) {
      this.knownWords = new Set(arg2);
      if (typeof arg3 === 'function') {
        this.onChoiceCallback = arg3 as ChoiceCallback;
      } else if (this.defaultOnChoice) {
        this.onChoiceCallback = this.defaultOnChoice;
      }
      if (typeof arg4 === 'function') {
        this.onCloseCallback = arg4 as CloseCallback;
      } else if (this.defaultOnClose) {
        this.onCloseCallback = this.defaultOnClose;
      }
    } else {
      if (this.defaultOnChoice) this.onChoiceCallback = this.defaultOnChoice;
      if (this.defaultOnClose) this.onCloseCallback = this.defaultOnClose;
    }

    // 1. Update NPC Name
    if (this.npcNameEl) {
      const displayName = NPC_NAMES[speech.npc_id] || speech.npc_id.toUpperCase();
      this.npcNameEl.textContent = displayName;
    }

    // 2. Update State Gauges (0..100%)
    this.updateGauges(speech.mianzi ?? 50, speech.aggro ?? 0);

    // 3. Render 2-Line Subtitles
    this.renderSubtitles();

    // 4. Render Choice Buttons
    this.renderChoices();

    // 5. Reveal Overlay
    if (this.overlayEl) {
      this.overlayEl.classList.remove('hidden');
    }
    this.isOpenState = true;

    // 6. Attach Keyboard Listener
    this.attachKeyboardListener();
  }

  /**
   * Closes dialogue overlay, detaches keyboard listeners, and invokes onClose callback.
   */
  public close(): void {
    if (!this.isOpenState && (this.overlayEl?.classList.contains('hidden') ?? true)) {
      return;
    }

    this.isOpenState = false;

    if (this.overlayEl) {
      this.overlayEl.classList.add('hidden');
    }

    this.detachKeyboardListener();

    if (this.onCloseCallback) {
      const cb = this.onCloseCallback;
      this.onCloseCallback = null;
      cb();
    }
  }

  /**
   * Returns whether dialogue overlay is currently open and visible.
   */
  public isOpen(): boolean {
    if (!this.isOpenState) return false;
    if (this.overlayEl && this.overlayEl.classList.contains('hidden')) {
      return false;
    }
    return true;
  }

  /**
   * Updates Mianzi (Respect) and Aggro (Rage) gauge bars and numerical text.
   * Clamps inputs to [0, 100].
   */
  public updateGauges(mianzi: number, aggro: number): void {
    const clampedMianzi = Math.max(0, Math.min(100, Math.round(mianzi)));
    const clampedAggro = Math.max(0, Math.min(100, Math.round(aggro)));

    this.currentMianzi = clampedMianzi;
    this.currentAggro = clampedAggro;

    if (this.mianziFillEl) {
      this.mianziFillEl.style.width = `${clampedMianzi}%`;
    }
    if (this.mianziValEl) {
      this.mianziValEl.textContent = `${clampedMianzi}%`;
    }

    if (this.aggroFillEl) {
      this.aggroFillEl.style.width = `${clampedAggro}%`;
    }
    if (this.aggroValEl) {
      this.aggroValEl.textContent = `${clampedAggro}%`;
    }
  }

  /**
   * Contract alias for updateGauges.
   */
  public updateState(mianzi: number, aggro: number): void {
    this.updateGauges(mianzi, aggro);
  }

  /**
   * Refreshes active dialogue subtitles with updated known vocabulary.
   * Replaces [???] with newly learned Russian translations without restarting dialogue
   * or resetting choice buttons.
   */
  public refreshSubtitles(knownWords: Set<string>): void {
    this.knownWords = new Set(knownWords);
    if (this.currentSpeech) {
      this.renderSubtitles();
    }
  }

  /**
   * Renders Line 1 (Chinese + Pinyin) and Line 2 (Russian with [???] token masking).
   * Punctuation tokens are preserved and not masked.
   */
  private renderSubtitles(): void {
    if (!this.currentSpeech || !Array.isArray(this.currentSpeech.tokens)) {
      return;
    }

    const tokens = this.currentSpeech.tokens;

    // Line 1: Chinese + Pinyin
    // Format: "你好 (Nǐ hǎo) 朋友 (péngyou)"
    const line1Formatted = tokens
      .map((t) => (t.py ? `${t.zh} (${t.py})` : t.zh))
      .join(' ');

    if (this.lineOriginalEl) {
      this.lineOriginalEl.textContent = line1Formatted;
    }

    // Line 2: Russian Translation with [???] Masking
    // Unknown tokens styled with .masked-token
    const line2Parts: string[] = [];

    for (const t of tokens) {
      const isExplicitMask = t.ru === '[???]';
      const isPunctuation =
        !t.id ||
        t.id.startsWith('punct') ||
        /^[\p{P}\p{S}]+$/u.test(t.zh);

      const isUnlearned = !isPunctuation && Boolean(t.id && !this.knownWords.has(t.id));

      if (isExplicitMask || isUnlearned) {
        line2Parts.push('<span class="masked-token">[???]</span>');
      } else {
        line2Parts.push(this.escapeHtml(t.ru));
      }
    }

    if (this.lineTranslatedEl) {
      this.lineTranslatedEl.innerHTML = line2Parts.join(' ');
    }
  }

  /**
   * Generates up to 4 interactive choice buttons inside #dialogue-choices.
   */
  private renderChoices(): void {
    if (!this.choicesContainerEl) return;

    this.choicesContainerEl.innerHTML = '';

    if (!this.currentSpeech || !Array.isArray(this.currentSpeech.choices)) {
      return;
    }

    const doc = this.docRef ?? (typeof document !== 'undefined' ? document : (globalThis as any).document);
    if (!doc) return;

    const choicesToRender = this.currentSpeech.choices.slice(0, 4);

    choicesToRender.forEach((choice, index) => {
      const btn = doc.createElement('button');
      btn.className = 'choice-btn';
      if (btn.dataset) {
        btn.dataset.choice = String(choice.id);
      }
      btn.setAttribute('data-choice-id', String(choice.id));

      const numBadge = doc.createElement('span');
      numBadge.className = 'choice-num';
      numBadge.textContent = `[${index + 1}]`;

      const textSpan = doc.createElement('span');
      textSpan.className = 'choice-text';

      if (choice.text_ru && choice.text_zh) {
        textSpan.textContent = `${choice.text_zh} (${choice.text_ru})`;
      } else {
        textSpan.textContent = choice.text_zh || choice.text_ru || '';
      }

      btn.appendChild(numBadge);
      btn.appendChild(textSpan);

      btn.addEventListener('click', () => {
        this.selectChoice(choice.id);
      });

      this.choicesContainerEl!.appendChild(btn);
    });
  }

  /**
   * Executes choice selection callback.
   */
  public selectChoice(choiceId: number): void {
    if (this.onChoiceCallback) {
      this.onChoiceCallback(choiceId);
    }
  }

  /**
   * Handles keyboard shortcuts when dialogue is open:
   * - Keys 1..4, Digit1..Digit4, Numpad1..Numpad4 triggers corresponding choice.
   * - Escape key closes dialogue overlay.
   */
  public handleKeyDown(e: KeyboardEvent | any): void {
    if (!this.isOpenState) return;

    if (e.key === 'Escape') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this.close();
      return;
    }

    let choiceIndex = -1;

    if (e.key >= '1' && e.key <= '4') {
      choiceIndex = parseInt(e.key, 10) - 1;
    } else if (typeof e.code === 'string' && e.code.startsWith('Digit')) {
      const digit = parseInt(e.code.replace('Digit', ''), 10);
      if (digit >= 1 && digit <= 4) choiceIndex = digit - 1;
    } else if (typeof e.code === 'string' && e.code.startsWith('Numpad')) {
      const digit = parseInt(e.code.replace('Numpad', ''), 10);
      if (digit >= 1 && digit <= 4) choiceIndex = digit - 1;
    }

    if (choiceIndex >= 0 && this.currentSpeech?.choices) {
      const choice = this.currentSpeech.choices[choiceIndex];
      if (choice) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        this.selectChoice(choice.id);
      }
    }
  }

  private attachKeyboardListener(): void {
    if (this.isListeningKeys) return;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    if (!win || typeof win.addEventListener !== 'function') return;
    win.addEventListener('keydown', this.boundKeyDownHandler);
    this.isListeningKeys = true;
  }

  private detachKeyboardListener(): void {
    if (!this.isListeningKeys) return;
    const win = typeof window !== 'undefined' ? window : (globalThis as any).window;
    if (win && typeof win.removeEventListener === 'function') {
      win.removeEventListener('keydown', this.boundKeyDownHandler);
    }
    this.isListeningKeys = false;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Cleans up all event listeners and DOM bindings.
   */
  public dispose(): void {
    this.close();
    this.detachKeyboardListener();
    this.currentSpeech = null;
    this.onChoiceCallback = null;
    this.onCloseCallback = null;
  }

  // -------------------------------------------------------------
  // Test & Diagnostic Inspection Getters
  // -------------------------------------------------------------
  public getOriginalText(): string {
    return this.lineOriginalEl?.textContent?.trim() ?? '';
  }

  public getTranslatedText(): string {
    return this.lineTranslatedEl?.textContent?.trim() ?? '';
  }

  public getTranslatedHtml(): string {
    return (this.lineTranslatedEl as any)?.innerHTML?.trim() ?? '';
  }

  public getMianzi(): number {
    return this.currentMianzi;
  }

  public getAggro(): number {
    return this.currentAggro;
  }

  public getMianziWidth(): string {
    return this.mianziFillEl?.style.width ?? '';
  }

  public getAggroWidth(): string {
    return this.aggroFillEl?.style.width ?? '';
  }

  public getMianziValText(): string {
    return this.mianziValEl?.textContent?.trim() ?? '';
  }

  public getAggroValText(): string {
    return this.aggroValEl?.textContent?.trim() ?? '';
  }

  public getNpcName(): string {
    return this.npcNameEl?.textContent?.trim() ?? '';
  }

  public getChoicesCount(): number {
    return this.choicesContainerEl?.children.length ?? 0;
  }

  public getChoiceButton(index: number): HTMLElement | null {
    if (!this.choicesContainerEl) return null;
    return (this.choicesContainerEl.children[index] as HTMLElement) ?? null;
  }

  public getChoiceText(index: number): string {
    const btn = this.getChoiceButton(index);
    return btn?.textContent?.trim() ?? '';
  }

  public getCurrentSpeech(): NpcSpeechPayload | null {
    return this.currentSpeech;
  }

  public getKnownWords(): Set<string> {
    return new Set(this.knownWords);
  }
}
