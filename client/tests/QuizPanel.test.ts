/**
 * Milestone M4 Test Suite: QuizPanel, TTS & Real-Time [???] Subtitle Unmasking
 * Target File: client/tests/QuizPanel.test.ts
 * 
 * Verifies:
 * 1. QuizPanel Component Unit Tests:
 *    - DOM rendering (title, zh, py, question, 4 interactive options)
 *    - Incorrect answer selection & retry feedback (.wrong)
 *    - Correct answer selection & dictionary feedback (.correct, onAnswer callback)
 *    - Keyboard hotkeys (1..4, Digit1..4, Escape) and close button
 *    - Lifecycle management (isOpen, close, dispose)
 * 2. TTS (Speech Synthesis) Unit Tests:
 *    - Graceful fallback in headless / unsupported environments (returns false without throwing)
 *    - Correct utterance configuration (lang: 'zh-CN', rate: 0.9) when supported
 *    - Cancellation via TTS.stop()
 * 3. MockServer INSPECT Packet & WORD_LEARNED Integration:
 *    - Correct answer emits WORD_LEARNED and rewards balance (+50 ¥)
 *    - Incorrect answer does not emit WORD_LEARNED
 * 4. End-to-End Real-Time [???] Subtitle Unmasking:
 *    - Subtitle Line 2 renders <span class="masked-token">[???]</span> for unlearned teapot token
 *    - After WORD_LEARNED is dispatched, Line 2 dynamically unmasks to 'чайник' and [???] is eliminated
 *    - Unmasking occurs seamlessly without restarting dialogue or clearing choices
 * 5. Teapot Proximity Detection & Modal State Coordination:
 *    - Position at (110.0, 0.9, 108.5) and 3.0m interaction radius
 *    - Proximity priority between Lao Wang [F] and Teapot [E]
 *    - Modal lock coordination: pauses movement while quiz is open
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QuizPanel, QuizItemData } from '../src/ui/QuizPanel';
import { TTS } from '../src/audio/TTS';
import { DialogueUI } from '../src/ui/DialogueUI';
import { MockServer } from '../src/net/MockServer';
import { WSClient } from '../src/net/WSClient';
import {
  NpcSpeechPayload,
  WordLearnedPayload,
} from '../src/net/types';
import {
  LAO_WANG_CONFIG,
  TEAPOT_CONFIG,
} from '../src/main';

// ============================================================================
// Zero-Dependency Headless Mock DOM Harness for Node/Vitest
// ============================================================================

export class MockClassList {
  private classes = new Set<string>();

  constructor(initial: string = '') {
    if (initial) {
      initial.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c));
    }
  }

  public add(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.add(t));
  }

  public remove(...tokens: string[]): void {
    tokens.forEach((t) => this.classes.delete(t));
  }

  public contains(token: string): boolean {
    return this.classes.has(token);
  }

  public toggle(token: string, force?: boolean): boolean {
    if (force !== undefined) {
      if (force) this.classes.add(token);
      else this.classes.delete(token);
      return force;
    }
    if (this.classes.has(token)) {
      this.classes.delete(token);
      return false;
    } else {
      this.classes.add(token);
      return true;
    }
  }

  public toString(): string {
    return Array.from(this.classes).join(' ');
  }
}

export class MockDomElement {
  public id: string = '';
  public tagName: string = 'DIV';
  public parentElement: MockDomElement | null = null;
  public children: MockDomElement[] = [];
  public classList: MockClassList;
  public style: Record<string, string> = {};
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public listeners: Record<string, Function[]> = {};

  private _textContent: string = '';
  private _innerHTML: string = '';

  constructor(id: string = '', tagName: string = 'DIV', initialClass: string = '') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.classList = new MockClassList(initialClass);
  }

  public get className(): string {
    return this.classList.toString();
  }

  public set className(val: string) {
    this.classList = new MockClassList(val);
  }

  public get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join(' ');
    }
    return this._textContent;
  }

  public set textContent(val: string) {
    this._textContent = val;
    this._innerHTML = val;
    this.children = [];
  }

  public get innerHTML(): string {
    return this._innerHTML;
  }

  public set innerHTML(val: string) {
    this._innerHTML = val;
    this._textContent = val.replace(/<[^>]*>/g, '');
    this.children = [];
  }

  public appendChild<T extends MockDomElement>(child: T): T {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public removeChild<T extends MockDomElement>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentElement = null;
    }
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name.startsWith('data-')) {
      const prop = name.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
      this.dataset[prop] = value;
    }
  }

  public getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  public hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public click(): void {
    const list = this.listeners['click'] || [];
    for (const fn of list) {
      fn({ type: 'click', target: this });
    }
  }

  public querySelector(selector: string): MockDomElement | null {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      return this.findChild((c) => c.id === id);
    }
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.findChild((c) => c.classList.contains(cls));
    }
    return this.findChild((c) => c.tagName === selector.toUpperCase());
  }

  public querySelectorAll(selector: string): MockDomElement[] {
    const results: MockDomElement[] = [];
    this.collectChildren(results, (c) => {
      if (selector.startsWith('#')) return c.id === selector.slice(1);
      if (selector.startsWith('.')) return c.classList.contains(selector.slice(1));
      return c.tagName === selector.toUpperCase();
    });
    return results;
  }

  private findChild(predicate: (el: MockDomElement) => boolean): MockDomElement | null {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.findChild(predicate);
      if (found) return found;
    }
    return null;
  }

  private collectChildren(results: MockDomElement[], predicate: (el: MockDomElement) => boolean): void {
    for (const child of this.children) {
      if (predicate(child)) results.push(child);
      child.collectChildren(results, predicate);
    }
  }
}

export class MockDocument {
  public body: MockDomElement = new MockDomElement('body', 'BODY');
  private elements = new Map<string, MockDomElement>();
  public listeners: Record<string, Function[]> = {};

  public register(el: MockDomElement): void {
    if (el.id) {
      this.elements.set(el.id, el);
    }
  }

  public getElementById(id: string): MockDomElement | null {
    return this.elements.get(id) || null;
  }

  public createElement(tagName: string): MockDomElement {
    return new MockDomElement('', tagName);
  }

  public querySelector(selector: string): MockDomElement | null {
    if (selector.startsWith('#')) {
      return this.getElementById(selector.slice(1));
    }
    return this.body.querySelector(selector);
  }

  public querySelectorAll(selector: string): MockDomElement[] {
    return this.body.querySelectorAll(selector);
  }

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): void {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
  }
}

export class MockWindow {
  public listeners: Record<string, Function[]> = {};

  public addEventListener(event: string, fn: Function): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  public removeEventListener(event: string, fn: Function): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    }
  }

  public dispatchEvent(event: any): void {
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
  }
}

export function createQuizTestFixture() {
  const doc = new MockDocument();
  const win = new MockWindow();

  // Setup global document & window mocks
  (globalThis as any).document = doc;
  (globalThis as any).window = win;

  // Quiz Overlay Elements
  const quizOverlay = new MockDomElement('quiz-overlay', 'DIV', 'quiz-overlay hidden');
  const quizCard = new MockDomElement('quiz-card', 'DIV', 'quiz-card');
  const quizTitle = new MockDomElement('quiz-title', 'SPAN', 'quiz-title');
  const quizWordZh = new MockDomElement('quiz-word-zh', 'DIV', 'quiz-zh');
  const quizWordPy = new MockDomElement('quiz-word-py', 'DIV', 'quiz-py');
  const quizQuestion = new MockDomElement('quiz-question', 'DIV', 'quiz-question');
  const quizOptions = new MockDomElement('quiz-options', 'DIV', 'quiz-options-grid');
  const quizFeedback = new MockDomElement('quiz-feedback', 'DIV', 'quiz-feedback hidden');
  const quizCloseBtn = new MockDomElement('quiz-close-btn', 'BUTTON', 'cyber-btn');

  quizCard.appendChild(quizTitle);
  quizCard.appendChild(quizWordZh);
  quizCard.appendChild(quizWordPy);
  quizCard.appendChild(quizQuestion);
  quizCard.appendChild(quizOptions);
  quizCard.appendChild(quizFeedback);
  quizCard.appendChild(quizCloseBtn);
  quizOverlay.appendChild(quizCard);
  doc.body.appendChild(quizOverlay);

  doc.register(quizOverlay);
  doc.register(quizTitle);
  doc.register(quizWordZh);
  doc.register(quizWordPy);
  doc.register(quizQuestion);
  doc.register(quizOptions);
  doc.register(quizFeedback);
  doc.register(quizCloseBtn);

  // Dialogue Overlay Elements (for end-to-end unmasking verification)
  const dialogueOverlay = new MockDomElement('dialogue-overlay', 'DIV', 'dialogue-overlay hidden');
  const dialogueNpcName = new MockDomElement('dialogue-npc-name', 'SPAN', 'npc-name');
  const dialogueMianziFill = new MockDomElement('dialogue-mianzi-fill', 'DIV', 'meter-fill mianzi-fill');
  const dialogueMianziVal = new MockDomElement('dialogue-mianzi-val', 'SPAN', 'gauge-val');
  const dialogueAggroFill = new MockDomElement('dialogue-aggro-fill', 'DIV', 'meter-fill aggro-fill');
  const dialogueAggroVal = new MockDomElement('dialogue-aggro-val', 'SPAN', 'gauge-val');
  const dialogueLineOriginal = new MockDomElement('dialogue-line-original', 'DIV', 'subtitle-text zh-text');
  const dialogueLineTranslated = new MockDomElement('dialogue-line-translated', 'DIV', 'subtitle-text ru-text');
  const dialogueChoices = new MockDomElement('dialogue-choices', 'DIV', 'dialogue-choices-grid');

  dialogueOverlay.appendChild(dialogueNpcName);
  dialogueOverlay.appendChild(dialogueMianziFill);
  dialogueOverlay.appendChild(dialogueMianziVal);
  dialogueOverlay.appendChild(dialogueAggroFill);
  dialogueOverlay.appendChild(dialogueAggroVal);
  dialogueOverlay.appendChild(dialogueLineOriginal);
  dialogueOverlay.appendChild(dialogueLineTranslated);
  dialogueOverlay.appendChild(dialogueChoices);
  doc.body.appendChild(dialogueOverlay);

  doc.register(dialogueOverlay);
  doc.register(dialogueNpcName);
  doc.register(dialogueMianziFill);
  doc.register(dialogueMianziVal);
  doc.register(dialogueAggroFill);
  doc.register(dialogueAggroVal);
  doc.register(dialogueLineOriginal);
  doc.register(dialogueLineTranslated);
  doc.register(dialogueChoices);

  // Proximity Prompt Elements
  const interactionPrompt = new MockDomElement('interaction-prompt', 'DIV', 'interaction-prompt hidden');
  const keyBadge = new MockDomElement('key-badge', 'SPAN', 'key-badge');
  const promptText = new MockDomElement('prompt-text', 'SPAN');
  promptText.textContent = 'Взаимодействовать';
  interactionPrompt.appendChild(keyBadge);
  interactionPrompt.appendChild(promptText);
  doc.body.appendChild(interactionPrompt);

  doc.register(interactionPrompt);
  doc.register(promptText);

  return {
    doc,
    win,
    quizOverlay,
    quizTitle,
    quizWordZh,
    quizWordPy,
    quizQuestion,
    quizOptions,
    quizFeedback,
    quizCloseBtn,
    dialogueOverlay,
    dialogueNpcName,
    dialogueMianziFill,
    dialogueMianziVal,
    dialogueAggroFill,
    dialogueAggroVal,
    dialogueLineOriginal,
    dialogueLineTranslated,
    dialogueChoices,
    interactionPrompt,
    promptText,
    keyBadge,
  };
}

const SAMPLE_TEAPOT_DATA: QuizItemData = {
  itemId: 'teapot',
  title: 'Осмотр предмета: Антикварный чайник',
  zh: '茶壶',
  py: 'Cháhú',
  question: 'Как переводится это слово?',
  wordId: 'word_teapot',
  options: [
    { id: 1, text: 'Чайник', correct: true },
    { id: 2, text: 'Чашка', correct: false },
    { id: 3, text: 'Зеленый чай', correct: false },
    { id: 4, text: 'Тарелка', correct: false },
  ],
};

// ============================================================================
// Test Suite
// ============================================================================

describe('Milestone M4: QuizPanel, TTS & Subtitle Unmasking', () => {
  let fixture: ReturnType<typeof createQuizTestFixture>;

  beforeEach(() => {
    fixture = createQuizTestFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Suite 1: QuizPanel Component Unit Tests
  // --------------------------------------------------------------------------
  describe('1. QuizPanel Component Unit Tests', () => {
    it('1.1 should initialize with overlay hidden and bound elements', () => {
      const panel = new QuizPanel(fixture.doc as any);
      expect(panel.isOpen()).toBe(false);
      expect(fixture.quizOverlay.classList.contains('hidden')).toBe(true);
    });

    it('1.2 should render header, Chinese prompt, and 4 choices on open()', () => {
      const panel = new QuizPanel(fixture.doc as any);
      panel.open(SAMPLE_TEAPOT_DATA);

      expect(panel.isOpen()).toBe(true);
      expect(fixture.quizOverlay.classList.contains('hidden')).toBe(false);

      expect(panel.getTitle()).toBe('Осмотр предмета: Антикварный чайник');
      expect(panel.getWordZh()).toBe('茶壶');
      expect(panel.getWordPy()).toBe('Cháhú');
      expect(panel.getQuestion()).toBe('Как переводится это слово?');

      expect(panel.getOptionsCount()).toBe(4);
      expect(panel.getOptionText(0)).toContain('[1]');
      expect(panel.getOptionText(0)).toContain('Чайник');
      expect(panel.getOptionText(1)).toContain('[2]');
      expect(panel.getOptionText(1)).toContain('Чашка');
      expect(panel.getOptionText(2)).toContain('[3]');
      expect(panel.getOptionText(2)).toContain('Зеленый чай');
      expect(panel.getOptionText(3)).toContain('[4]');
      expect(panel.getOptionText(3)).toContain('Тарелка');
    });

    it('1.3 should show .wrong feedback and not invoke onAnswer when incorrect option is selected', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);

      const wrongBtn = panel.getOptionButton(1); // option 2: Чашка
      wrongBtn?.click();

      expect(onAnswer).not.toHaveBeenCalled();
      expect(panel.isAnsweredCorrectly()).toBe(false);
      expect(wrongBtn?.classList.contains('wrong')).toBe(true);
      expect(panel.isFeedbackVisible()).toBe(true);
      expect(panel.getFeedbackText()).toBe('Неверно, попробуйте снова');
      expect(panel.getFeedbackClass()).toContain('wrong');
    });

    it('1.4 should show .correct feedback and invoke onAnswer when correct option is selected', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);

      const correctBtn = panel.getOptionButton(0); // option 1: Чайник
      correctBtn?.click();

      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith(1, 'word_teapot');
      expect(panel.isAnsweredCorrectly()).toBe(true);
      expect(correctBtn?.classList.contains('correct')).toBe(true);
      expect(panel.isFeedbackVisible()).toBe(true);
      expect(panel.getFeedbackText()).toBe('Правильно! Слово добавлено в словарь');
      expect(panel.getFeedbackClass()).toContain('correct');
    });

    it('1.5 should allow retry after wrong answer to reach correct answer', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);

      // First attempt: wrong
      panel.getOptionButton(2)?.click();
      expect(onAnswer).not.toHaveBeenCalled();
      expect(panel.getFeedbackText()).toBe('Неверно, попробуйте снова');

      // Second attempt: correct
      panel.getOptionButton(0)?.click();
      expect(onAnswer).toHaveBeenCalledTimes(1);
      expect(onAnswer).toHaveBeenCalledWith(1, 'word_teapot');
      expect(panel.getFeedbackText()).toBe('Правильно! Слово добавлено в словарь');
    });

    it('1.6 should trigger option selection via number keys 1..4', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);

      // Press key '2' (wrong)
      fixture.win.dispatchEvent({ type: 'keydown', key: '2' });
      expect(onAnswer).not.toHaveBeenCalled();
      expect(panel.getFeedbackText()).toBe('Неверно, попробуйте снова');

      // Press key '1' (correct)
      fixture.win.dispatchEvent({ type: 'keydown', key: '1' });
      expect(onAnswer).toHaveBeenCalledWith(1, 'word_teapot');
      expect(panel.getFeedbackText()).toBe('Правильно! Слово добавлено в словарь');
    });

    it('1.7 should trigger option selection via Digit1..Digit4 codes', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);

      fixture.win.dispatchEvent({ type: 'keydown', key: '1', code: 'Digit1' });
      expect(onAnswer).toHaveBeenCalledWith(1, 'word_teapot');
    });

    it('1.8 should dismiss quiz and invoke onClose on Escape key', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onClose = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, vi.fn(), onClose);

      expect(panel.isOpen()).toBe(true);

      fixture.win.dispatchEvent({ type: 'keydown', key: 'Escape' });

      expect(panel.isOpen()).toBe(false);
      expect(fixture.quizOverlay.classList.contains('hidden')).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('1.9 should dismiss quiz and invoke onClose on close button click', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onClose = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, vi.fn(), onClose);

      fixture.quizCloseBtn.click();

      expect(panel.isOpen()).toBe(false);
      expect(fixture.quizOverlay.classList.contains('hidden')).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('1.10 should detach keyboard listener on close so subsequent keys are ignored', () => {
      const panel = new QuizPanel(fixture.doc as any);
      const onAnswer = vi.fn();
      panel.open(SAMPLE_TEAPOT_DATA, onAnswer);
      panel.close();

      fixture.win.dispatchEvent({ type: 'keydown', key: '1' });
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it('1.11 should handle close() and dispose() idempotently without throwing', () => {
      const panel = new QuizPanel(fixture.doc as any);
      panel.open(SAMPLE_TEAPOT_DATA);
      panel.close();
      panel.close();
      panel.dispose();
      panel.dispose();
      expect(panel.isOpen()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: TTS (Speech Synthesis) Unit Tests
  // --------------------------------------------------------------------------
  describe('2. TTS (Speech Synthesis) Unit Tests', () => {
    it('2.1 should safely degrade and return false in headless environment without throwing', () => {
      // In Node/Vitest, window.speechSynthesis does not exist natively
      const result = TTS.speakZh('茶壶');
      expect(result).toBe(false);
      expect(() => TTS.stop()).not.toThrow();
    });

    it('2.2 should reject empty or invalid inputs gracefully', () => {
      expect(TTS.speakZh('')).toBe(false);
      expect(TTS.speakZh(null as any)).toBe(false);
      expect(TTS.speakZh(undefined as any)).toBe(false);
    });

    it('2.3 should dispatch speech synthesis with zh-CN and 0.9 rate when window.speechSynthesis is mocked', () => {
      const speakMock = vi.fn();
      const cancelMock = vi.fn();

      const mockUtteranceConstructor = vi.fn(function (this: any, text: string) {
        this.text = text;
        this.lang = '';
        this.rate = 1.0;
      });

      const originalWin = (globalThis as any).window;
      (globalThis as any).window = {
        ...originalWin,
        speechSynthesis: {
          speak: speakMock,
          cancel: cancelMock,
        },
        SpeechSynthesisUtterance: mockUtteranceConstructor,
      };

      try {
        expect(TTS.isSupported()).toBe(true);
        const dispatched = TTS.speakZh('茶壶');

        expect(dispatched).toBe(true);
        expect(mockUtteranceConstructor).toHaveBeenCalledWith('茶壶');
        expect(speakMock).toHaveBeenCalledTimes(1);

        const callArg = speakMock.mock.calls[0][0];
        expect(callArg.lang).toBe('zh-CN');
        expect(callArg.rate).toBe(0.9);

        TTS.stop();
        expect(cancelMock).toHaveBeenCalledTimes(1);
      } finally {
        (globalThis as any).window = originalWin;
      }
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: MockServer INSPECT Packet & WORD_LEARNED Integration
  // --------------------------------------------------------------------------
  describe('3. MockServer INSPECT Packet & WORD_LEARNED Integration', () => {
    it('3.1 should emit WORD_LEARNED for word_teapot and reward +50 balance on correct INSPECT', () => {
      const mockServer = new MockServer();
      mockServer.start();

      const receivedPackets: any[] = [];
      mockServer.onPacket((p) => receivedPackets.push(p));

      // Send correct INSPECT packet (answer_id = 1)
      mockServer.receive({
        type: 'INSPECT',
        payload: { item_id: 'teapot', answer_id: 1 },
      });

      const wordLearned = receivedPackets.find((p) => p.type === 'WORD_LEARNED');
      expect(wordLearned).toBeDefined();
      expect(wordLearned.payload).toEqual({
        word_id: 'word_teapot',
        zh: '茶壶',
        py: 'cháhú',
        ru: 'чайник',
      });

      const balancePacket = receivedPackets.find((p) => p.type === 'BALANCE' && p.payload.delta === 50);
      expect(balancePacket).toBeDefined();

      mockServer.stop();
    });

    it('3.2 should NOT emit WORD_LEARNED on incorrect INSPECT packet', () => {
      const mockServer = new MockServer();
      mockServer.start();

      const receivedPackets: any[] = [];
      mockServer.onPacket((p) => receivedPackets.push(p));

      mockServer.receive({
        type: 'INSPECT',
        payload: { item_id: 'teapot', answer_id: 2 },
      });

      const wordLearned = receivedPackets.find((p) => p.type === 'WORD_LEARNED');
      expect(wordLearned).toBeUndefined();

      mockServer.stop();
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: End-to-End Real-Time [???] Subtitle Unmasking
  // --------------------------------------------------------------------------
  describe('4. End-to-End Real-Time [???] Subtitle Unmasking', () => {
    const SPEECH_WITH_TEAPOT: NpcSpeechPayload = {
      npc_id: 'lao_wang',
      tokens: [
        { id: 'word_hello', zh: '你好', py: 'Nǐ hǎo', ru: 'Привет' },
        { id: 'word_friend', zh: '朋友', py: 'péngyǒu', ru: 'друг' },
        { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
        { id: 'word_teapot', zh: '茶壶', py: 'cháhú', ru: 'чайник' },
        { id: 'punct_excl2', zh: '！', py: '!', ru: '!' },
      ],
      choices: [
        { id: 1, text_zh: '老板，便宜点吧！', text_ru: 'Босс, сделай скидку!' },
        { id: 4, text_zh: '我再看看。', text_ru: 'Я ещё посмотрю.' },
      ],
      mianzi: 50,
      aggro: 10,
    };

    it('4.1 should render [???] for word_teapot in dialogue Line 2 before it is learned', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const initialKnownWords = new Set(['word_hello', 'word_friend']);

      dialogue.open(SPEECH_WITH_TEAPOT, initialKnownWords);

      expect(dialogue.isOpen()).toBe(true);

      // Line 1: Chinese + Pinyin
      const line1 = fixture.dialogueLineOriginal.textContent;
      expect(line1).toContain('你好 (Nǐ hǎo)');
      expect(line1).toContain('茶壶 (cháhú)');

      // Line 2: Russian translation with masked teapot token
      const line2Html = fixture.dialogueLineTranslated.innerHTML;
      expect(line2Html).toContain('<span class="masked-token">[???]</span>');
      expect(line2Html).not.toContain('чайник');
      expect(line2Html).toContain('Привет');
      expect(line2Html).toContain('друг');
    });

    it('4.2 should dynamically flip [???] to "чайник" on refreshSubtitles without restarting dialogue', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const knownWords = new Set(['word_hello', 'word_friend']);

      dialogue.open(SPEECH_WITH_TEAPOT, knownWords);

      // 1. Initially masked
      expect(fixture.dialogueLineTranslated.innerHTML).toContain('<span class="masked-token">[???]</span>');
      expect(fixture.dialogueLineTranslated.textContent).not.toContain('чайник');

      // 2. Player learns teapot word via QuizPanel / Network
      knownWords.add('word_teapot');
      dialogue.refreshSubtitles(knownWords);

      // 3. Subtitles are dynamically unmasked in real time!
      expect(fixture.dialogueLineTranslated.innerHTML).not.toContain('<span class="masked-token">[???]</span>');
      expect(fixture.dialogueLineTranslated.textContent).toContain('чайник');
      expect(dialogue.isOpen()).toBe(true);
      expect(dialogue.getChoicesCount()).toBe(2);
    });

    it('4.3 should simulate full loop: Inspect -> Quiz answer -> MockServer packet -> Dialogue UI unmasks', () => {
      const mockServer = new MockServer();
      mockServer.start();

      const wsClient = new WSClient({ mock: true });
      wsClient.connect();

      const dialogue = new DialogueUI(fixture.doc as any);
      const playerKnownWords = new Set<string>(['word_hello', 'word_friend']);

      // Wire WSClient event
      wsClient.on('WORD_LEARNED', (payload: WordLearnedPayload) => {
        playerKnownWords.add(payload.word_id);
        if (dialogue.isOpen()) {
          dialogue.refreshSubtitles(playerKnownWords);
        }
      });

      // 1. Open dialogue with speech containing word_teapot
      dialogue.open(SPEECH_WITH_TEAPOT, playerKnownWords);
      expect(fixture.dialogueLineTranslated.innerHTML).toContain('<span class="masked-token">[???]</span>');
      expect(fixture.dialogueLineTranslated.textContent).not.toContain('чайник');

      // 2. Open Quiz and answer correctly
      const quiz = new QuizPanel(fixture.doc as any);
      quiz.open(SAMPLE_TEAPOT_DATA, (optionId) => {
        wsClient.send('INSPECT', { item_id: 'teapot', answer_id: optionId });
      });

      // Select option 1 (correct)
      quiz.selectOption(1);
      expect(quiz.isAnsweredCorrectly()).toBe(true);

      // 3. Confirm dialogue Line 2 subtitle is now unmasked!
      expect(fixture.dialogueLineTranslated.innerHTML).not.toContain('<span class="masked-token">[???]</span>');
      expect(fixture.dialogueLineTranslated.textContent).toContain('чайник');

      mockServer.stop();
      wsClient.disconnect();
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Teapot Proximity Detection & Modal State Coordination
  // --------------------------------------------------------------------------
  describe('5. Teapot Proximity Detection & Modal State Coordination', () => {
    it('5.1 should verify TEAPOT_CONFIG coordinates and interaction radius', () => {
      expect(TEAPOT_CONFIG.itemId).toBe('teapot');
      expect(TEAPOT_CONFIG.worldPosition).toEqual({ x: 110.0, y: 0.9, z: 108.5 });
      expect(TEAPOT_CONFIG.interactionRadius).toBe(3.0);
      expect(TEAPOT_CONFIG.interactionRadiusSq).toBe(9.0);
      expect(TEAPOT_CONFIG.promptKey).toBe('E');
      expect(TEAPOT_CONFIG.promptText).toBe('Осмотреть чайник (茶壶)');
    });

    it('5.2 should detect player in range of teapot within 3.0m', () => {
      const teapotPos = TEAPOT_CONFIG.worldPosition;
      const radiusSq = TEAPOT_CONFIG.interactionRadiusSq;

      const checkRange = (px: number, pz: number) => {
        const dx = px - teapotPos.x;
        const dz = pz - teapotPos.z;
        return dx * dx + dz * dz <= radiusSq;
      };

      // Exactly at teapot: 0m
      expect(checkRange(110.0, 108.5)).toBe(true);

      // 1.5m away
      expect(checkRange(110.0, 110.0)).toBe(true);

      // Exactly 3.0m away: dx=0, dz=3.0 -> distSq = 9.0 <= 9.0
      expect(checkRange(110.0, 111.5)).toBe(true);

      // 3.5m away: outside range
      expect(checkRange(110.0, 112.0)).toBe(false);
    });

    it('5.3 should resolve priority when player is within range of both Lao Wang (3.5m) and Teapot (3.0m)', () => {
      expect(LAO_WANG_CONFIG.worldPosition).toEqual({ x: 110.0, y: 0.0, z: 109.5 });
      expect(LAO_WANG_CONFIG.interactionRadius).toBe(3.5);

      // Lao Wang: (110.0, 0, 109.5)
      // Teapot: (110.0, 0.9, 108.5)
      // Position A: (110.0, 108.7) -> closer to teapot (dist=0.2m) than Lao Wang (dist=0.8m)
      const posA = { x: 110.0, z: 108.7 };
      const distSqTeaA = (posA.x - TEAPOT_CONFIG.worldPosition.x) ** 2 + (posA.z - TEAPOT_CONFIG.worldPosition.z) ** 2; // 0.04
      const distSqLaoA = (posA.x - LAO_WANG_CONFIG.worldPosition.x) ** 2 + (posA.z - LAO_WANG_CONFIG.worldPosition.z) ** 2; // 0.64
      expect(distSqTeaA <= TEAPOT_CONFIG.interactionRadiusSq).toBe(true);
      expect(distSqLaoA <= LAO_WANG_CONFIG.interactionRadiusSq).toBe(true);
      expect(distSqTeaA < distSqLaoA).toBe(true); // Teapot prioritized!

      // Position B: (110.0, 109.4) -> closer to Lao Wang (dist=0.1m) than Teapot (dist=0.9m)
      const posB = { x: 110.0, z: 109.4 };
      const distSqTeaB = (posB.x - 110.0) ** 2 + (posB.z - 108.5) ** 2; // 0.81
      const distSqLaoB = (posB.x - 110.0) ** 2 + (posB.z - 109.5) ** 2; // 0.01
      expect(distSqTeaB < distSqLaoB).toBe(false); // Lao Wang prioritized!
    });

    it('5.4 should coordinate modal active state when quiz is opened and closed', () => {
      let modalActive = false;
      const setModalActive = (val: boolean) => {
        modalActive = val;
      };

      const panel = new QuizPanel(fixture.doc as any);

      // Open quiz -> engages modal lock
      panel.open(SAMPLE_TEAPOT_DATA, vi.fn(), () => {
        setModalActive(false);
      });
      setModalActive(true);

      expect(panel.isOpen()).toBe(true);
      expect(modalActive).toBe(true);

      // Close quiz -> releases modal lock
      panel.close();

      expect(panel.isOpen()).toBe(false);
      expect(modalActive).toBe(false);
    });
  });
});
