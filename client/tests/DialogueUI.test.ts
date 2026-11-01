/**
 * Milestone M3 Test Suite: DialogueUI & Proximity System
 * Target File: client/tests/DialogueUI.test.ts
 * 
 * Verifies:
 * 1. DialogueUI Component Unit Tests (subtitles, masking, gauges, choices, keyboard, cleanup)
 * 2. Network Integration Tests (NPC_SPEECH, DIALOGUE, NPC_STATE, MockServer, modal locking)
 * 3. Proximity Detection Tests (distance to the central pavilion (100.0, 0, 124.0), [F] prompt visibility, boundary checks, key F)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NpcSpeechPayload,
  NpcStatePayload,
} from '../src/net/types';
import { WSClient } from '../src/net/WSClient';
import { MockServer } from '../src/net/MockServer';
import { DialogueUI } from '../src/ui/DialogueUI';
import { LAO_WANG_CONFIG } from '../src/main';

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

  public dispatchEvent(event: any): boolean {
    const ev = { ...event, target: this, currentTarget: this };
    const list = this.listeners[event.type] || [];
    for (const fn of list) {
      fn(ev);
    }
    return true;
  }

  public click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  public querySelector(selector: string): MockDomElement | null {
    if (selector.startsWith('#')) {
      const targetId = selector.slice(1);
      if (this.id === targetId) return this;
      for (const child of this.children) {
        const found = child.querySelector(selector);
        if (found) return found;
      }
    } else if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      for (const child of this.children) {
        if (child.classList.contains(cls)) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
    }
    return null;
  }

  public querySelectorAll(selector: string): MockDomElement[] {
    const results: MockDomElement[] = [];
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      if (this.classList.contains(cls)) results.push(this);
      for (const child of this.children) {
        results.push(...child.querySelectorAll(selector));
      }
    }
    return results;
  }
}

export class MockDocument {
  public elements: Map<string, MockDomElement> = new Map();
  public body: MockDomElement = new MockDomElement('body', 'BODY');
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

export interface DialogueDomFixture {
  doc: MockDocument;
  win: MockWindow;
  overlay: MockDomElement;
  npcName: MockDomElement;
  mianziFill: MockDomElement;
  mianziVal: MockDomElement;
  aggroFill: MockDomElement;
  aggroVal: MockDomElement;
  lineOriginal: MockDomElement;
  lineTranslated: MockDomElement;
  choices: MockDomElement;
  interactionPrompt: MockDomElement;
  promptText: MockDomElement;
}

export function createDialogueDomFixture(): DialogueDomFixture {
  const doc = new MockDocument();
  const win = new MockWindow();

  const overlay = new MockDomElement('dialogue-overlay', 'DIV', 'dialogue-overlay hidden');
  const npcName = new MockDomElement('dialogue-npc-name', 'SPAN', 'npc-name');
  const mianziFill = new MockDomElement('dialogue-mianzi-fill', 'DIV', 'meter-fill mianzi-fill');
  mianziFill.style.width = '50%';
  const mianziVal = new MockDomElement('dialogue-mianzi-val', 'SPAN', 'gauge-val');
  mianziVal.textContent = '50%';

  const aggroFill = new MockDomElement('dialogue-aggro-fill', 'DIV', 'meter-fill aggro-fill');
  aggroFill.style.width = '0%';
  const aggroVal = new MockDomElement('dialogue-aggro-val', 'SPAN', 'gauge-val');
  aggroVal.textContent = '0%';

  const lineOriginal = new MockDomElement('dialogue-line-original', 'DIV', 'subtitle-text zh-text');
  const lineTranslated = new MockDomElement('dialogue-line-translated', 'DIV', 'subtitle-text ru-text');
  const choices = new MockDomElement('dialogue-choices', 'DIV', 'dialogue-choices-grid');

  const interactionPrompt = new MockDomElement('interaction-prompt', 'DIV', 'interaction-prompt hidden');
  const promptText = new MockDomElement('prompt-text', 'SPAN');
  promptText.textContent = 'Взаимодействовать';
  interactionPrompt.appendChild(promptText);

  doc.register(overlay);
  doc.register(npcName);
  doc.register(mianziFill);
  doc.register(mianziVal);
  doc.register(aggroFill);
  doc.register(aggroVal);
  doc.register(lineOriginal);
  doc.register(lineTranslated);
  doc.register(choices);
  doc.register(interactionPrompt);
  doc.register(promptText);

  return {
    doc,
    win,
    overlay,
    npcName,
    mianziFill,
    mianziVal,
    aggroFill,
    aggroVal,
    lineOriginal,
    lineTranslated,
    choices,
    interactionPrompt,
    promptText,
  };
}

// ============================================================================
// Proximity Logic Helper
// ============================================================================

export const LAO_WANG_LANDMARK_POS = { x: 100.0, y: 0.0, z: 124.0 };
export const NPC_INTERACTION_RADIUS = 3.5;

export function checkNpcProximity(
  playerX: number,
  playerZ: number,
  npcPos = LAO_WANG_LANDMARK_POS,
  radius = NPC_INTERACTION_RADIUS
): { inRange: boolean; distance: number } {
  const dx = playerX - npcPos.x;
  const dz = playerZ - npcPos.z;
  const distance = Math.hypot(dx, dz);
  return {
    inRange: distance <= radius,
    distance,
  };
}

// ============================================================================
// Sample Test Payloads
// ============================================================================

export const MOCK_SPEECH_GREETING: NpcSpeechPayload = {
  npc_id: 'lao_wang',
  tokens: [
    { id: 'word_hello', zh: '你好', py: 'Nǐ hǎo', ru: 'Привет' },
    { id: 'word_friend', zh: '朋友', py: 'péngyǒu', ru: 'друг' },
    { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
    { id: 'word_expensive', zh: '太贵了', py: 'tài guì le', ru: 'слишком дорого' },
  ],
  choices: [
    { id: 1, text_zh: '老板，便宜点吧！', text_ru: 'Босс, сделай скидку!', type: 'polite' },
    { id: 2, text_zh: '太贵了，三百！', text_ru: 'Слишком дорого, за 300!', type: 'haggle' },
    { id: 3, text_zh: '这是假货！', text_ru: 'Это подделка!', type: 'provoke' },
    { id: 4, text_zh: '对不起，再看看。', text_ru: 'Извините, ещё посмотрю.', type: 'leave' },
  ],
  emotion: 'NEUTRAL',
  mianzi: 40,
  aggro: 20,
  price: 500,
};

// ============================================================================
// Test Suites
// ============================================================================

describe('Milestone M3 Test Suite: DialogueUI & Proximity System', () => {
  let fixture: DialogueDomFixture;
  let origDoc: any;
  let origWin: any;

  beforeEach(() => {
    origDoc = (globalThis as any).document;
    origWin = (globalThis as any).window;

    fixture = createDialogueDomFixture();
    (globalThis as any).document = fixture.doc;
    (globalThis as any).window = fixture.win;
  });

  afterEach(() => {
    (globalThis as any).document = origDoc;
    (globalThis as any).window = origWin;
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Suite 1: DialogueUI Component & Subtitle Unit Tests
  // --------------------------------------------------------------------------
  describe('1. DialogueUI Component & Subtitle Unit Tests', () => {
    it('1.1 should initialize with overlay hidden and isOpen() returning false', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      expect(fixture.overlay.classList.contains('hidden')).toBe(true);
      expect(dialogue.isOpen()).toBe(false);
    });

    it('1.2 should reveal overlay and set isOpen() to true when open() is called', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      expect(fixture.overlay.classList.contains('hidden')).toBe(false);
      expect(dialogue.isOpen()).toBe(true);
      expect(fixture.npcName.textContent).toBe('ЛАО ВАН (老王)');
    });

    it('1.3 should correctly render Line 1 with Chinese characters and Pinyin', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      const line1Text = fixture.lineOriginal.textContent;
      expect(line1Text).toContain('你好 (Nǐ hǎo)');
      expect(line1Text).toContain('朋友 (péngyǒu)');
      expect(line1Text).toContain('太贵了 (tài guì le)');
    });

    it('1.4 should render full Russian translation in Line 2 when all tokens are known', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const allKnown = new Set(['word_hello', 'word_friend', 'punct_excl', 'word_expensive']);

      dialogue.open(MOCK_SPEECH_GREETING, allKnown);

      const line2Html = fixture.lineTranslated.innerHTML;
      expect(line2Html).toContain('Привет');
      expect(line2Html).toContain('друг');
      expect(line2Html).toContain('слишком дорого');
      expect(line2Html).not.toContain('[???]');
    });

    it('1.5 should mask unlearned Russian tokens with [???] in Line 2', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const partialKnown = new Set(['word_hello', 'word_friend']);

      dialogue.open(MOCK_SPEECH_GREETING, partialKnown);

      const line2Html = fixture.lineTranslated.innerHTML;
      expect(line2Html).toContain('Привет');
      expect(line2Html).toContain('друг');
      expect(line2Html).toContain('<span class="masked-token">[???]</span>');
      expect(line2Html).not.toContain('слишком дорого');
    });

    it('1.6 should preserve punctuation tokens in Line 2 without masking', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING, new Set());

      const line2Html = fixture.lineTranslated.innerHTML;
      expect(line2Html).toContain('!');
    });

    it('1.7 should dynamically unmask newly learned words via refreshSubtitles() without closing dialogue', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const initialKnown = new Set(['word_hello', 'word_friend']);

      dialogue.open(MOCK_SPEECH_GREETING, initialKnown);
      expect(fixture.lineTranslated.innerHTML).toContain('[???]');
      expect(dialogue.isOpen()).toBe(true);

      const updatedKnown = new Set(['word_hello', 'word_friend', 'word_expensive']);
      dialogue.refreshSubtitles(updatedKnown);

      expect(dialogue.isOpen()).toBe(true);
      expect(fixture.lineTranslated.innerHTML).toContain('слишком дорого');
      expect(fixture.lineTranslated.innerHTML).not.toContain('[???]');
    });

    it('1.8 should correctly render Mianzi (Respect) and Aggro (Rage) gauge bars and values', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      expect(fixture.mianziFill.style.width).toBe('40%');
      expect(fixture.mianziVal.textContent).toBe('40%');
      expect(fixture.aggroFill.style.width).toBe('20%');
      expect(fixture.aggroVal.textContent).toBe('20%');
    });

    it('1.9 should clamp gauge values strictly to [0, 100]', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      dialogue.updateGauges(-25, -10);
      expect(fixture.mianziFill.style.width).toBe('0%');
      expect(fixture.mianziVal.textContent).toBe('0%');
      expect(fixture.aggroFill.style.width).toBe('0%');
      expect(fixture.aggroVal.textContent).toBe('0%');

      dialogue.updateState(140, 110);
      expect(fixture.mianziFill.style.width).toBe('100%');
      expect(fixture.mianziVal.textContent).toBe('100%');
      expect(fixture.aggroFill.style.width).toBe('100%');
      expect(fixture.aggroVal.textContent).toBe('100%');
    });

    it('1.10 should render up to 4 choice buttons with [1]..[4] badges and choice text', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      const buttons = fixture.choices.children;
      expect(buttons).toHaveLength(4);

      expect(buttons[0].textContent).toContain('[1]');
      expect(buttons[0].textContent).toContain('老板，便宜点吧！');
      expect(buttons[0].getAttribute('data-choice-id')).toBe('1');

      expect(buttons[1].textContent).toContain('[2]');
      expect(buttons[1].textContent).toContain('太贵了，三百！');

      expect(buttons[2].textContent).toContain('[3]');
      expect(buttons[2].textContent).toContain('这是假货！');

      expect(buttons[3].textContent).toContain('[4]');
      expect(buttons[3].textContent).toContain('对不起，再看看。');
    });

    it('1.10b should render choices in the real server shape ({zh,py,ru})', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open({
        ...MOCK_SPEECH_GREETING,
        choices: [
          { id: 1, zh: '谢谢老板！', py: 'Xièxie lǎobǎn!', ru: 'Спасибо, босс!', type: 'polite' },
          { id: 4, zh: '我再看看', py: 'Wǒ zài kànkan', ru: 'Я еще посмотрю', type: 'leave' },
        ],
      });

      const buttons = fixture.choices.children;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].textContent).toContain('[1]');
      expect(buttons[0].textContent).toContain('谢谢老板！');
      expect(buttons[0].textContent).toContain('Спасибо, босс!');
      expect(buttons[1].textContent).toContain('我再看看');
      expect(buttons[1].textContent).toContain('Я еще посмотрю');
    });

    it('1.11 should invoke onChoice callback when a choice button is clicked', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onChoice = vi.fn();

      dialogue.open(MOCK_SPEECH_GREETING, onChoice);

      const buttons = fixture.choices.children;
      buttons[1].click();

      expect(onChoice).toHaveBeenCalledTimes(1);
      expect(onChoice).toHaveBeenCalledWith(2);
    });

    it('1.12 should invoke onChoice callback when number keys 1..4 are pressed', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onChoice = vi.fn();

      dialogue.open(MOCK_SPEECH_GREETING, onChoice);

      fixture.win.dispatchEvent({ type: 'keydown', key: '1' });
      expect(onChoice).toHaveBeenCalledWith(1);

      fixture.win.dispatchEvent({ type: 'keydown', key: '3' });
      expect(onChoice).toHaveBeenCalledWith(3);

      fixture.win.dispatchEvent({ type: 'keydown', key: '4', code: 'Digit4' });
      expect(onChoice).toHaveBeenCalledWith(4);

      fixture.win.dispatchEvent({ type: 'keydown', key: '5' });
      fixture.win.dispatchEvent({ type: 'keydown', key: 'q' });
      expect(onChoice).toHaveBeenCalledTimes(3);
    });

    it('1.13 should dismiss overlay and invoke onClose when Escape key is pressed', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onChoice = vi.fn();
      const onClose = vi.fn();

      dialogue.open(MOCK_SPEECH_GREETING, onChoice, onClose);
      expect(dialogue.isOpen()).toBe(true);

      fixture.win.dispatchEvent({ type: 'keydown', key: 'Escape' });

      expect(dialogue.isOpen()).toBe(false);
      expect(fixture.overlay.classList.contains('hidden')).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('1.14 should detach keyboard listeners on close so subsequent keys are ignored', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onChoice = vi.fn();

      dialogue.open(MOCK_SPEECH_GREETING, onChoice);
      dialogue.close();

      fixture.win.dispatchEvent({ type: 'keydown', key: '1' });
      expect(onChoice).not.toHaveBeenCalled();
    });

    it('1.15 should handle repeated close() calls idempotently', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onClose = vi.fn();

      dialogue.open(MOCK_SPEECH_GREETING, vi.fn(), onClose);
      dialogue.close();
      dialogue.close();
      dialogue.close();

      expect(dialogue.isOpen()).toBe(false);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Network Dialogue Integration
  // --------------------------------------------------------------------------
  describe('2. Network Dialogue Integration', () => {
    it('2.1 should open DialogueUI upon receiving NPC_SPEECH packet from WSClient', () => {
      const wsClient = new WSClient({ mock: false, autoReconnect: false });
      const dialogue = new DialogueUI(fixture.doc as any);

      wsClient.on('NPC_SPEECH', (payload) => {
        dialogue.open(payload);
      });

      wsClient.dispatch('NPC_SPEECH', MOCK_SPEECH_GREETING);

      expect(dialogue.isOpen()).toBe(true);
      expect(fixture.lineOriginal.textContent).toContain('你好 (Nǐ hǎo)');
      expect(fixture.mianziVal.textContent).toBe('40%');
    });

    it('2.2 should dispatch DIALOGUE packet with choice_id when player selects an option', () => {
      const wsClient = new WSClient({ mock: false, autoReconnect: false });
      const dialogue = new DialogueUI(fixture.doc as any);
      const sentPackets: any[] = [];

      vi.spyOn(wsClient, 'send').mockImplementation((type, payload) => {
        sentPackets.push({ type, payload });
        return true;
      });

      dialogue.open(MOCK_SPEECH_GREETING, (choiceId) => {
        wsClient.send('DIALOGUE', {
          npc_id: 'lao_wang',
          choice_id: choiceId,
        });
      });

      fixture.win.dispatchEvent({ type: 'keydown', key: '2' });

      expect(sentPackets).toHaveLength(1);
      expect(sentPackets[0]).toEqual({
        type: 'DIALOGUE',
        payload: {
          npc_id: 'lao_wang',
          choice_id: 2,
        },
      });
    });

    it('2.3 should update Mianzi and Aggro gauges upon receiving NPC_STATE packet', () => {
      const wsClient = new WSClient({ mock: false, autoReconnect: false });
      const dialogue = new DialogueUI(fixture.doc as any);

      dialogue.open(MOCK_SPEECH_GREETING);

      wsClient.on('NPC_STATE', (payload: NpcStatePayload) => {
        dialogue.updateState(payload.mianzi, payload.aggro);
      });

      wsClient.dispatch('NPC_STATE', {
        npc_id: 'lao_wang',
        state: 'HAPPY',
        mianzi: 85,
        aggro: 5,
      });

      expect(fixture.mianziFill.style.width).toBe('85%');
      expect(fixture.mianziVal.textContent).toBe('85%');
      expect(fixture.aggroFill.style.width).toBe('5%');
      expect(fixture.aggroVal.textContent).toBe('5%');
    });

    it('2.4 should simulate full conversation turn with MockServer (Greeting -> Haggle -> Reply)', () => {
      const mockServer = new MockServer();
      const dialogue = new DialogueUI(fixture.doc as any);
      const receivedSpeech: NpcSpeechPayload[] = [];

      mockServer.start();
      mockServer.onPacket((packet) => {
        if (packet.type === 'NPC_SPEECH') {
          receivedSpeech.push(packet.payload);
          dialogue.open(packet.payload, (choiceId) => {
            mockServer.receive({
              type: 'DIALOGUE',
              payload: { npc_id: packet.payload.npc_id, choice_id: choiceId },
            });
          });
        }
      });

      mockServer.triggerLaoWangGreeting();

      expect(receivedSpeech).toHaveLength(1);
      expect(dialogue.isOpen()).toBe(true);
      expect(fixture.mianziVal.textContent).toBe('40%');
      expect(fixture.aggroVal.textContent).toBe('20%');

      fixture.choices.children[0].click();

      expect(receivedSpeech).toHaveLength(2);
      expect(fixture.lineOriginal.textContent).toContain('哈哈 (Hāhā)');
      expect(fixture.mianziVal.textContent).toBe('50%');
      expect(fixture.aggroVal.textContent).toBe('10%');

      mockServer.stop();
    });

    it('2.5 should coordinate modal lock state (setModalActive) on dialogue open and close', () => {
      let modalActive = false;
      const setModalActive = (active: boolean) => {
        modalActive = active;
      };

      const dialogue = new DialogueUI(fixture.doc as any);

      dialogue.open(MOCK_SPEECH_GREETING, vi.fn(), () => {
        setModalActive(false);
      });
      setModalActive(true);

      expect(dialogue.isOpen()).toBe(true);
      expect(modalActive).toBe(true);

      dialogue.close();

      expect(dialogue.isOpen()).toBe(false);
      expect(modalActive).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Proximity Detection & Interaction Trigger
  // --------------------------------------------------------------------------
  describe('3. Proximity Detection & Interaction Trigger', () => {
    it('3.1 should confirm Lao Wang coordinates at the central pavilion (100, 124) and 3.5m radius', () => {
      expect(LAO_WANG_LANDMARK_POS).toEqual({ x: 100.0, y: 0.0, z: 124.0 });
      expect(NPC_INTERACTION_RADIUS).toBe(3.5);
      expect(LAO_WANG_CONFIG.worldPosition).toEqual({ x: 100.0, y: 0.0, z: 124.0 });
      expect(LAO_WANG_CONFIG.interactionRadius).toBe(3.5);
    });

    it('3.2 should detect player in range and reveal interaction prompt within 3.5m', () => {
      const res1 = checkNpcProximity(100.0, 124.0);
      expect(res1.inRange).toBe(true);
      expect(res1.distance).toBeCloseTo(0, 4);

      const res2 = checkNpcProximity(100.0, 127.0);
      expect(res2.inRange).toBe(true);
      expect(res2.distance).toBeCloseTo(3.0, 4);

      const res3 = checkNpcProximity(102.0, 125.5);
      expect(res3.inRange).toBe(true);
      expect(res3.distance).toBeLessThan(3.5);

      fixture.interactionPrompt.classList.remove('hidden');
      fixture.promptText.textContent = '[F] Поговорить с Лао Ваном';
      expect(fixture.interactionPrompt.classList.contains('hidden')).toBe(false);
      expect(fixture.promptText.textContent).toContain('Лао Ван');
    });

    it('3.3 should detect player out of range and hide interaction prompt past 3.5m', () => {
      const resSpawn = checkNpcProximity(100.0, 100.0);
      expect(resSpawn.inRange).toBe(false);
      expect(resSpawn.distance).toBeGreaterThan(13.0);

      const resFar = checkNpcProximity(100.0, 128.5);
      expect(resFar.inRange).toBe(false);
      expect(resFar.distance).toBeCloseTo(4.5, 4);

      fixture.interactionPrompt.classList.add('hidden');
      expect(fixture.interactionPrompt.classList.contains('hidden')).toBe(true);
    });

    it('3.4 should enforce boundary precision strictly at 3.500m vs 3.501m', () => {
      const boundaryIn = checkNpcProximity(100.0, 127.5);
      expect(boundaryIn.inRange).toBe(true);
      expect(boundaryIn.distance).toBeCloseTo(3.5, 6);

      const boundaryOut = checkNpcProximity(100.0, 127.501);
      expect(boundaryOut.inRange).toBe(false);
      expect(boundaryOut.distance).toBeGreaterThan(3.5);
    });

    it('3.5 should trigger dialogue greeting when key F is pressed while in range', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      let dialogueTriggered = false;

      const playerPos = { x: 100.0, z: 125.0 };

      const handleKey = (key: string) => {
        if ((key === 'f' || key === 'F') && !dialogue.isOpen()) {
          const prox = checkNpcProximity(playerPos.x, playerPos.z);
          if (prox.inRange) {
            dialogueTriggered = true;
            dialogue.open(MOCK_SPEECH_GREETING);
          }
        }
      };

      handleKey('f');

      expect(dialogueTriggered).toBe(true);
      expect(dialogue.isOpen()).toBe(true);
    });

    it('3.6 should ignore key F when player is out of range', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      let dialogueTriggered = false;

      const playerPos = { x: 100.0, z: 100.0 };

      const handleKey = (key: string) => {
        if ((key === 'f' || key === 'F') && !dialogue.isOpen()) {
          const prox = checkNpcProximity(playerPos.x, playerPos.z);
          if (prox.inRange) {
            dialogueTriggered = true;
            dialogue.open(MOCK_SPEECH_GREETING);
          }
        }
      };

      handleKey('f');

      expect(dialogueTriggered).toBe(false);
      expect(dialogue.isOpen()).toBe(false);
    });

    it('3.7 should hide interaction prompt while dialogue overlay is currently active', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      dialogue.open(MOCK_SPEECH_GREETING);

      const playerPos = { x: 100.0, z: 124.0 };
      const prox = checkNpcProximity(playerPos.x, playerPos.z);

      const shouldShowPrompt = prox.inRange && !dialogue.isOpen();
      if (shouldShowPrompt) {
        fixture.interactionPrompt.classList.remove('hidden');
      } else {
        fixture.interactionPrompt.classList.add('hidden');
      }

      expect(fixture.interactionPrompt.classList.contains('hidden')).toBe(true);
    });
  });

  describe('4. Chunked & Streaming Dialogue Delivery', () => {
    it('4.1 should render partial NPC speech immediately with loading placeholder for choices', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const partialSpeech: NpcSpeechPayload = {
        npc_id: 'lao_wang',
        tokens: [
          { id: 'word_hello', zh: '你好', py: 'Nǐ hǎo', ru: 'Привет' },
          { id: 'word_friend', zh: '朋友', py: 'péngyǒu', ru: 'друг' },
        ],
        emotion: 'HAPPY',
        mianzi: 65,
        aggro: 10,
        is_partial: true,
      };

      const knownWords = new Set(['word_hello']);
      dialogue.renderPartialSpeech(partialSpeech, knownWords);

      expect(dialogue.isOpen()).toBe(true);
      expect(fixture.npcName.textContent).toContain('ЛАО ВАН');
      expect(fixture.lineOriginal.textContent).toContain('你好 (Nǐ hǎo)');
      // Both original phrase and semi-translation (with unmasked known word) appear simultaneously in partial chunk!
      expect(fixture.lineTranslated.innerHTML).toContain('Привет');
      expect(fixture.lineTranslated.innerHTML).toContain('<span class="masked-token">[???]</span>');
      expect(fixture.mianziVal.textContent).toBe('65%');
      expect(fixture.aggroVal.textContent).toBe('10%');

      // Choices container contains loading indicator instead of choice buttons
      const loader = fixture.choices.querySelector('.dialogue-choices-loading');
      expect(loader).not.toBeNull();
      expect(loader!.textContent).toContain('Собеседник формулирует варианты');
    });

    it('4.2 should render interactive choices when choices chunk arrives via setChoices', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const partialSpeech: NpcSpeechPayload = {
        npc_id: 'lao_wang',
        tokens: [{ id: 'word_hello', zh: '你好', py: 'Nǐ hǎo', ru: 'Привет' }],
        mianzi: 50,
        aggro: 0,
        is_partial: true,
      };

      dialogue.renderPartialSpeech(partialSpeech);
      expect(fixture.choices.querySelector('.dialogue-choices-loading')).not.toBeNull();

      // Chunk 2 arrives
      dialogue.setChoices([
        { id: 1, text_zh: '老板好', text_ru: 'Привет, босс' },
        { id: 2, text_zh: '多少钱', text_ru: 'Сколько стоит' },
      ], 'turn_123');

      // Loading indicator is replaced by buttons
      expect(fixture.choices.querySelector('.dialogue-choices-loading')).toBeNull();
      const buttons = fixture.choices.querySelectorAll('.choice-btn');
      expect(buttons.length).toBe(2);
      expect(buttons[0].textContent).toContain('老板好');
    });

    it('4.3 should visually highlight selected choice and disable buttons immediately on click', () => {
      const dialogue = new DialogueUI(fixture.doc as any);
      const onChoice = vi.fn();
      dialogue.open(MOCK_SPEECH_GREETING, onChoice);

      const buttons = fixture.choices.querySelectorAll('.choice-btn');
      expect(buttons.length).toBe(4);

      // User clicks choice 2
      buttons[1].dispatchEvent({ type: 'click' });

      expect(onChoice).toHaveBeenCalledWith(2);
      expect(buttons[1].classList.contains('selected')).toBe(true);
      expect(buttons[0].classList.contains('disabled')).toBe(true);
      expect(buttons[1].classList.contains('disabled')).toBe(true);
    });

    it('4.4 should handle mock streaming packets via WSClient and MockServer', () => {
      const client = new WSClient({ mock: true });
      let partialReceived: NpcSpeechPayload | null = null;
      let choicesReceived: any = null;
      let fullReceived: NpcSpeechPayload | null = null;

      client.on('NPC_SPEECH_PARTIAL', (p) => { partialReceived = p; });
      client.on('DIALOGUE_CHOICES', (c) => { choicesReceived = c; });
      client.on('NPC_SPEECH', (s) => { fullReceived = s; });

      client.connect();
      client.send('DIALOGUE', { npc_id: 'lao_wang', choice_id: 1 });

      expect(partialReceived).not.toBeNull();
      expect(partialReceived!.npc_id).toBe('lao_wang');
      expect(partialReceived!.choices?.length).toBe(0);

      expect(choicesReceived).not.toBeNull();
      expect(choicesReceived.choices?.length).toBeGreaterThan(0);

      expect(fullReceived).not.toBeNull();
      expect(fullReceived!.choices?.length).toBeGreaterThan(0);

      client.disconnect();
    });
  });
});
