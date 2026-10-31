/**
 * QuizPanel: Item Vocabulary Inspection & Quiz Interface (Milestone M4).
 * Controls the Shenzhen Night Market quiz overlay (#quiz-overlay).
 * 
 * Features:
 * 1. Modal presentation for inspectable world objects (e.g., Antique Teapot 茶壶).
 * 2. Visual header displaying object title, Chinese characters (zh), Pinyin (py), and prompt question.
 * 3. 4 interactive choice buttons with keyboard hotkeys [1]..[4] and mouse click support.
 * 4. Real-time feedback validation (.correct: "Правильно! Слово добавлено в словарь", .wrong: "Неверно, попробуйте снова").
 * 5. On correct answer: invokes onAnswer callback to dispatch INSPECT packet and trigger WORD_LEARNED unmasking.
 * 6. Responsive dismissal via Escape key and #quiz-close-btn.
 */

export interface QuizOption {
  id: number;
  text: string;
  correct?: boolean;
}

export interface QuizItemData {
  itemId: string;
  title: string;
  zh: string;
  py: string;
  question: string;
  options: QuizOption[];
  wordId: string;
}

export type QuizAnswerCallback = (optionId: number, wordId: string) => void;
export type QuizCloseCallback = () => void;

export interface QuizPanelOptions {
  rootContainer?: Document | HTMLElement | any;
  onAnswer?: QuizAnswerCallback;
  onClose?: QuizCloseCallback;
}

export interface IQuizPanel {
  open(itemData: QuizItemData, onAnswer?: QuizAnswerCallback, onClose?: QuizCloseCallback): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export class QuizPanel implements IQuizPanel {
  // DOM References
  private docRef: any = null;
  private overlayEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private wordZhEl: HTMLElement | null = null;
  private wordPyEl: HTMLElement | null = null;
  private questionEl: HTMLElement | null = null;
  private optionsContainerEl: HTMLElement | null = null;
  private feedbackEl: HTMLElement | null = null;
  private closeBtnEl: HTMLElement | null = null;

  // Active State
  private currentItemData: QuizItemData | null = null;
  private onAnswerCallback: QuizAnswerCallback | null = null;
  private onCloseCallback: QuizCloseCallback | null = null;
  private defaultOnAnswer: QuizAnswerCallback | null = null;
  private defaultOnClose: QuizCloseCallback | null = null;

  private isOpenState = false;
  private isListeningKeys = false;
  private hasAnsweredCorrectly = false;

  // Bound Listeners
  private boundKeyDownHandler: (e: KeyboardEvent | any) => void;
  private boundCloseHandler: () => void;

  constructor(rootOrOptions?: Document | HTMLElement | QuizPanelOptions | any) {
    this.boundKeyDownHandler = this.handleKeyDown.bind(this);
    this.boundCloseHandler = this.close.bind(this);

    if (
      rootOrOptions &&
      typeof rootOrOptions === 'object' &&
      !('getElementById' in rootOrOptions) &&
      !('querySelector' in rootOrOptions) &&
      ('onAnswer' in rootOrOptions || 'onClose' in rootOrOptions || 'rootContainer' in rootOrOptions)
    ) {
      const opts = rootOrOptions as QuizPanelOptions;
      if (opts.onAnswer) {
        this.defaultOnAnswer = opts.onAnswer;
        this.onAnswerCallback = opts.onAnswer;
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

    this.overlayEl = getEl('quiz-overlay');
    this.titleEl = getEl('quiz-title');
    this.wordZhEl = getEl('quiz-word-zh');
    this.wordPyEl = getEl('quiz-word-py');
    this.optionsContainerEl = getEl('quiz-options');
    this.feedbackEl = getEl('quiz-feedback');
    this.closeBtnEl = getEl('quiz-close-btn');

    // Query question element if present inside overlay
    if (this.overlayEl && typeof this.overlayEl.querySelector === 'function') {
      this.questionEl = this.overlayEl.querySelector('.quiz-question') || getEl('quiz-question');
    }

    if (this.closeBtnEl && typeof this.closeBtnEl.addEventListener === 'function') {
      this.closeBtnEl.addEventListener('click', this.boundCloseHandler);
    }
  }

  /**
   * Opens the quiz modal overlay with item data, renders options, and wires callbacks.
   */
  public open(
    itemData: QuizItemData,
    onAnswer?: QuizAnswerCallback,
    onClose?: QuizCloseCallback
  ): void {
    this.currentItemData = itemData;
    this.hasAnsweredCorrectly = false;

    if (typeof onAnswer === 'function') {
      this.onAnswerCallback = onAnswer;
    } else if (this.defaultOnAnswer) {
      this.onAnswerCallback = this.defaultOnAnswer;
    }

    if (typeof onClose === 'function') {
      this.onCloseCallback = onClose;
    } else if (this.defaultOnClose) {
      this.onCloseCallback = this.defaultOnClose;
    }

    // 1. Populate Header & Chinese Prompt
    if (this.titleEl) {
      this.titleEl.textContent = itemData.title;
    }
    if (this.wordZhEl) {
      this.wordZhEl.textContent = itemData.zh;
    }
    if (this.wordPyEl) {
      this.wordPyEl.textContent = itemData.py;
    }
    if (this.questionEl && itemData.question) {
      this.questionEl.textContent = itemData.question;
    }

    // 2. Reset Feedback Element
    if (this.feedbackEl) {
      this.feedbackEl.classList.add('hidden');
      this.feedbackEl.classList.remove('correct', 'wrong');
      this.feedbackEl.textContent = '';
    }

    // 3. Render 4 Options
    this.renderOptions(itemData.options);

    // 4. Reveal Overlay
    if (this.overlayEl) {
      this.overlayEl.classList.remove('hidden');
    }
    this.isOpenState = true;

    // 5. Attach Keyboard Listeners
    this.attachKeyboardListener();
  }

  /**
   * Closes the quiz overlay, detaches keyboard listeners, and invokes onClose callback.
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
   * Returns whether quiz overlay is currently open and visible.
   */
  public isOpen(): boolean {
    if (!this.isOpenState) return false;
    if (this.overlayEl && this.overlayEl.classList.contains('hidden')) {
      return false;
    }
    return true;
  }

  /**
   * Generates up to 4 interactive option buttons inside #quiz-options.
   */
  private renderOptions(options: QuizOption[]): void {
    if (!this.optionsContainerEl) return;

    this.optionsContainerEl.innerHTML = '';

    if (!Array.isArray(options)) return;

    const doc = this.docRef ?? (typeof document !== 'undefined' ? document : (globalThis as any).document);
    if (!doc) return;

    const optionsToRender = options.slice(0, 4);

    optionsToRender.forEach((opt, index) => {
      const btn = doc.createElement('button');
      btn.className = 'quiz-option-btn';
      if (btn.dataset) {
        btn.dataset.optionId = String(opt.id);
        btn.dataset.index = String(index);
      }
      btn.setAttribute('data-option-id', String(opt.id));
      btn.setAttribute('data-index', String(index));

      const numBadge = doc.createElement('span');
      numBadge.className = 'choice-num';
      numBadge.textContent = `[${index + 1}] `;

      const textSpan = doc.createElement('span');
      textSpan.className = 'option-text';
      textSpan.textContent = opt.text;

      btn.appendChild(numBadge);
      btn.appendChild(textSpan);

      btn.addEventListener('click', () => {
        this.selectOption(opt.id);
      });

      this.optionsContainerEl!.appendChild(btn);
    });
  }

  /**
   * Evaluates the selected option ID:
   * - Shows visual feedback (.correct or .wrong).
   * - Invokes onAnswer callback on correct response.
   */
  public showServerResult(correct: boolean): void {
    this.hasAnsweredCorrectly = correct;
    if (this.feedbackEl) {
      this.feedbackEl.classList.remove('hidden', 'correct', 'wrong');
      this.feedbackEl.classList.add(correct ? 'correct' : 'wrong');
      this.feedbackEl.textContent = correct ? 'Правильно! Слово изучено.' : 'Неверно. Закройте окно и осмотрите предмет снова.';
    }
    this.optionsContainerEl?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  }

  public selectOption(optionId: number): void {
    if (!this.isOpenState || !this.currentItemData) return;

    const opt = this.currentItemData.options.find((o) => o.id === optionId);
    if (!opt) return;

    // Online quizzes are checked by Go; no correct answer travels to the browser.
    if (opt.correct === undefined) {
      this.onAnswerCallback?.(opt.id, this.currentItemData.wordId);
      return;
    }

    // Find corresponding button DOM element
    let targetBtn: HTMLElement | null = null;
    if (this.optionsContainerEl) {
      const children = Array.from(this.optionsContainerEl.children) as HTMLElement[];
      targetBtn = children.find(
        (el) => el.getAttribute('data-option-id') === String(optionId)
      ) || null;
    }

    if (opt.correct) {
      this.hasAnsweredCorrectly = true;

      // Update button styling
      if (targetBtn) {
        targetBtn.classList.remove('wrong');
        targetBtn.classList.add('correct');
      }

      // Display positive feedback
      if (this.feedbackEl) {
        this.feedbackEl.classList.remove('hidden', 'wrong');
        this.feedbackEl.classList.add('correct');
        this.feedbackEl.textContent = 'Правильно! Слово добавлено в словарь';
      }

      // Notify callback
      if (this.onAnswerCallback) {
        this.onAnswerCallback(opt.id, this.currentItemData.wordId);
      }
    } else {
      // Update button styling
      if (targetBtn) {
        targetBtn.classList.remove('correct');
        targetBtn.classList.add('wrong');
      }

      // Display retry feedback
      if (this.feedbackEl) {
        this.feedbackEl.classList.remove('hidden', 'correct');
        this.feedbackEl.classList.add('wrong');
        this.feedbackEl.textContent = 'Неверно, попробуйте снова';
      }
    }
  }

  /**
   * Handles keyboard shortcuts when quiz is open:
   * - Keys 1..4, Digit1..Digit4, Numpad1..Numpad4 triggers answer selection.
   * - Escape key closes quiz modal.
   */
  public handleKeyDown(e: KeyboardEvent | any): void {
    if (!this.isOpenState) return;

    if (e.key === 'Escape') {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      this.close();
      return;
    }

    let optionIndex = -1;

    if (e.key >= '1' && e.key <= '4') {
      optionIndex = parseInt(e.key, 10) - 1;
    } else if (typeof e.code === 'string' && e.code.startsWith('Digit')) {
      const digit = parseInt(e.code.replace('Digit', ''), 10);
      if (digit >= 1 && digit <= 4) optionIndex = digit - 1;
    } else if (typeof e.code === 'string' && e.code.startsWith('Numpad')) {
      const digit = parseInt(e.code.replace('Numpad', ''), 10);
      if (digit >= 1 && digit <= 4) optionIndex = digit - 1;
    }

    if (optionIndex >= 0 && this.currentItemData?.options) {
      const opt = this.currentItemData.options[optionIndex];
      if (opt) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        this.selectOption(opt.id);
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

  /**
   * Cleans up all event listeners and DOM bindings.
   */
  public dispose(): void {
    this.close();
    if (this.closeBtnEl && typeof this.closeBtnEl.removeEventListener === 'function') {
      this.closeBtnEl.removeEventListener('click', this.boundCloseHandler);
    }
    this.detachKeyboardListener();
    this.currentItemData = null;
    this.onAnswerCallback = null;
    this.onCloseCallback = null;
  }

  // -------------------------------------------------------------
  // Test & Diagnostic Inspection Getters
  // -------------------------------------------------------------
  public getTitle(): string {
    return this.titleEl?.textContent?.trim() ?? '';
  }

  public getWordZh(): string {
    return this.wordZhEl?.textContent?.trim() ?? '';
  }

  public getWordPy(): string {
    return this.wordPyEl?.textContent?.trim() ?? '';
  }

  public getQuestion(): string {
    return this.questionEl?.textContent?.trim() ?? '';
  }

  public getFeedbackText(): string {
    return this.feedbackEl?.textContent?.trim() ?? '';
  }

  public isFeedbackVisible(): boolean {
    if (!this.feedbackEl) return false;
    return !this.feedbackEl.classList.contains('hidden');
  }

  public getFeedbackClass(): string {
    return this.feedbackEl?.className ?? '';
  }

  public getOptionsCount(): number {
    return this.optionsContainerEl?.children.length ?? 0;
  }

  public getOptionButton(index: number): HTMLElement | null {
    if (!this.optionsContainerEl) return null;
    return (this.optionsContainerEl.children[index] as HTMLElement) ?? null;
  }

  public getOptionText(index: number): string {
    const btn = this.getOptionButton(index);
    return btn?.textContent?.trim() ?? '';
  }

  public getCurrentItemData(): QuizItemData | null {
    return this.currentItemData;
  }

  public isAnsweredCorrectly(): boolean {
    return this.hasAnsweredCorrectly;
  }
}
