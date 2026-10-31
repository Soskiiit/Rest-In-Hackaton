/**
 * Rest-In-Hackaton: Application Bootstrap & Main Entry Point
 * Orchestrates 3D World, PlayerController, Multiplayer Avatars, WSClient / MockServer, HUD, and DialogueUI.
 */

import './style.css';
import { World } from './engine/World';
import { PlayerController } from './engine/PlayerController';
import { OtherPlayerManager } from './engine/OtherPlayerManager';
import { WSClient } from './net/WSClient';
import { MockServer } from './net/MockServer';
import { HUD } from './ui/HUD';
import { DialogueUI } from './ui/DialogueUI';
import { QuizPanel } from './ui/QuizPanel';
import { TTS } from './audio/TTS';
import {
  NpcSpeechPayload,
  NpcStatePayload,
  WordLearnedPayload,
} from './net/types';

// Network & Transmission Configuration
const MOVE_SEND_INTERVAL_SEC = 0.05; // 20 Hz (50 ms)
const DEFAULT_WS_PORT = '3000';

// Lao Wang Landmark & Proximity Configuration
export const LAO_WANG_CONFIG = {
  id: 'lao_wang',
  name: 'Лао Ван (老王)',
  worldPosition: { x: 110.0, y: 0.0, z: 109.5 },
  // Additional central position in North Plaza matching the pink square
  centralPosition: { x: 100.0, y: 0.0, z: 124.0 },
  chunkCoord: { cx: 5, cz: 5 },
  interactionRadius: 3.5,
  interactionRadiusSq: 12.25, // 3.5 * 3.5
  promptKey: 'F',
  promptText: 'Поговорить с Лао Ваном',
};

// Inspectable Antique Teapot Landmark & Proximity Configuration (Stage 4)
export const TEAPOT_CONFIG = {
  itemId: 'teapot',
  wordId: 'word_teapot',
  title: 'Осмотр предмета: Антикварный чайник',
  zh: '茶壶',
  py: 'Cháhú',
  question: 'Как переводится это слово?',
  worldPosition: { x: 110.0, y: 0.9, z: 108.5 },
  centralPosition: { x: 99.2, y: 0.9, z: 124.3 },
  chunkCoord: { cx: 5, cz: 5 },
  interactionRadius: 3.0,
  interactionRadiusSq: 9.0, // 3.0 * 3.0
  promptKey: 'E',
  promptText: 'Осмотреть чайник (茶壶)',
  options: [
    { id: 1, text: 'Чайник', correct: true },
    { id: 2, text: 'Чашка', correct: false },
    { id: 3, text: 'Зеленый чай', correct: false },
    { id: 4, text: 'Тарелка', correct: false },
  ],
};

class Application {
  private world!: World;
  private playerController!: PlayerController;
  private otherPlayerManager!: OtherPlayerManager;
  private wsClient!: WSClient;
  private mockServer: MockServer | null = null;
  private hud!: HUD;
  private dialogueUI!: DialogueUI;
  private quizPanel!: QuizPanel;

  // DOM Elements
  private blockerEl!: HTMLElement;
  private interactionPromptEl!: HTMLElement;

  // Loop & Transmission Timers
  private lastTime = performance.now();
  private moveAccumulator = 0;
  private lastSentX = Infinity;
  private lastSentZ = Infinity;
  private lastSentRotation = Infinity;

  // FPS Diagnostics
  private frameCount = 0;
  private fpsAccumulator = 0;
  private currentFps = 60;

  // Player Telemetry & Vocabulary
  private playerBalance = 500;
  private knownWords = new Set<string>();

  // Modal Lock & Interaction State
  private isModalActive = false;
  private isNearLaoWang = false;
  private isNearTeapot = false;
  private activeNpcId: string | null = null;

  public async init(): Promise<void> {
    console.log('[Main] Initializing Rest-In-Hackaton Client...');

    this.bindDomElements();
    this.initHUD();
    this.initDialogueUI();
    this.initQuizPanel();
    this.initWorldAndEngine();
    await this.initNetworking();
    this.bindInputAndPointerLock();
    this.bindWindowEvents();

    console.log('[Main] Initialization complete. Starting render loop.');
    requestAnimationFrame((t) => this.animate(t));
  }

  private bindDomElements(): void {
    const blocker = document.getElementById('blocker');
    const prompt = document.getElementById('interaction-prompt');

    if (!blocker || !prompt) {
      throw new Error('[Main] Required DOM elements (#blocker or #interaction-prompt) missing.');
    }

    this.blockerEl = blocker;
    this.interactionPromptEl = prompt;
    this.interactionPromptEl.classList.add('hidden');
  }

  private initHUD(): void {
    this.hud = new HUD();
  }

  private initDialogueUI(): void {
    this.dialogueUI = new DialogueUI({
      onChoice: (choiceId: number) => {
        this.handleDialogueChoice(choiceId);
      },
      onClose: () => {
        this.handleDialogueClose();
      },
    });
  }

  private initQuizPanel(): void {
    this.quizPanel = new QuizPanel({
      onAnswer: (optionId: number, wordId: string) => {
        this.handleQuizAnswer(optionId, wordId);
      },
      onClose: () => {
        this.handleQuizClose();
      },
    });
  }

  private initWorldAndEngine(): void {
    const container = document.getElementById('canvas-container');
    if (!container) {
      throw new Error('[Main] #canvas-container element not found.');
    }

    // 1. Initialize 3D World (Scene, Fog, Lighting, 200x200 Ground)
    this.world = new World(container);

    // 2. Initialize Player Controller (WASD + Mouse Look)
    this.playerController = new PlayerController(this.world.getCamera(), document.body);

    // 3. Initialize Remote Players Avatar Manager
    this.otherPlayerManager = new OtherPlayerManager(this.world.getScene());
  }

  private wireNetworkHandlers(client: WSClient): void {
    // 1. Remote Player Movement (Stage 1)
    client.on('PLAYER_MOVE', (payload) => {
      this.otherPlayerManager.updatePlayer(payload);
    });

    // 2. Economy Balance (Stage 1 & 2)
    client.on('BALANCE', (payload) => {
      this.playerBalance = payload.balance;
      this.hud.updateBalance(payload.balance);
    });

    // 3. NPC Speech: Trigger Dialogue Overlay (Stage 3)
    client.on('NPC_SPEECH', (payload: NpcSpeechPayload) => {
      this.handleNpcSpeech(payload);
    });

    // 4. NPC State: Update Mianzi / Aggro Gauges (Stage 3)
    client.on('NPC_STATE', (payload: NpcStatePayload) => {
      this.handleNpcState(payload);
    });

    // 5. Word Learned: Dynamic Subtitle Unmasking & TTS Pronunciation (Stage 4)
    client.on('WORD_LEARNED', (payload: WordLearnedPayload) => {
      this.handleWordLearned(payload);
    });
  }

  private async initNetworking(): Promise<void> {
    const urlParams = new URLSearchParams(window.location.search);
    const forceMock = urlParams.get('mock') === 'true' || urlParams.get('demo') === 'true';

    const wsHost = window.location.hostname || 'localhost';
    const wsPort = urlParams.get('ws_port') || DEFAULT_WS_PORT;
    const wsUrl = `ws://${wsHost}:${wsPort}/ws`;

    if (forceMock) {
      this.activateMockServer();
      return;
    }

    this.wsClient = new WSClient(wsUrl);
    this.wireNetworkHandlers(this.wsClient);

    try {
      await this.wsClient.connect();
      this.hud.setWsStatus('connected');
      console.log(`[Main] Connected to WebSocket backend at ${wsUrl}`);
    } catch (err) {
      console.warn('[Main] Connection to Go backend failed. Activating standalone MockServer fallback.', err);
      this.activateMockServer();
    }
  }

  private activateMockServer(): void {
    console.log('[Main] Running in standalone MockServer mode.');
    this.wsClient = new WSClient({ mock: true });
    this.wsClient.connect();
    this.mockServer = this.wsClient.getMockServer();
    this.wireNetworkHandlers(this.wsClient);
    this.hud.setWsStatus('mock');
  }

  private bindInputAndPointerLock(): void {
    // Clicking instructions blocker engages PointerLock
    this.blockerEl.addEventListener('click', () => {
      if (!this.isModalActive && !this.dialogueUI?.isOpen() && !this.quizPanel?.isOpen()) {
        this.playerController.requestPointerLock();
      }
    });

    this.playerController.onLock(() => {
      this.blockerEl.classList.add('hidden');
    });

    this.playerController.onUnlock(() => {
      if (!this.isModalActive && !this.dialogueUI?.isOpen() && !this.quizPanel?.isOpen()) {
        this.blockerEl.classList.remove('hidden');
      }
    });
  }

  private bindWindowEvents(): void {
    window.addEventListener('resize', () => {
      this.world.onResize();
    });

    window.addEventListener('beforeunload', () => {
      this.wsClient?.disconnect();
      this.mockServer?.stop();
      this.world?.dispose();
    });

    // Key 'F' interaction trigger (Lao Wang NPC Dialogue)
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      if (
        event.code === 'KeyF' ||
        event.key === 'f' ||
        event.key === 'F' ||
        event.key === 'а' ||
        event.key === 'А'
      ) {
        this.handleInteractKey(event);
      }
    });

    // Key 'E' interaction trigger (Antique Teapot Quiz Inspection)
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      if (
        event.code === 'KeyE' ||
        event.key === 'e' ||
        event.key === 'E' ||
        event.key === 'у' ||
        event.key === 'У'
      ) {
        this.handleTeapotKey(event);
      }
    });
  }

  /**
   * Modal Lock API used by DialogueUI (Stage 3) and QuizPanel (Stage 4).
   * Unlocks pointer and suspends WASD movement while modal is open.
   */
  public setModalActive(active: boolean): void {
    this.isModalActive = active;
    this.playerController.setModalActive(active);

    if (active) {
      this.playerController.exitPointerLock();
      this.blockerEl.classList.add('hidden');
    } else {
      // Re-enable pointer lock prompt if needed
      if (!this.dialogueUI?.isOpen() && !this.quizPanel?.isOpen()) {
        this.blockerEl.classList.remove('hidden');
      }
    }
  }

  /**
   * Inbound NPC Speech packet handler. Opens or updates DialogueUI and engages modal lock.
   */
  private handleNpcSpeech(payload: NpcSpeechPayload): void {
    console.log(`[Main] NPC speech received from '${payload.npc_id}' (${payload.tokens?.length ?? 0} tokens)`);
    this.activeNpcId = payload.npc_id;

    // 1. Activate UI modal lock (frees mouse pointer, suspends WASD)
    this.setModalActive(true);

    // 2. Hide proximity prompt
    this.hideInteractionPrompt();

    // 3. Open DialogueUI
    this.dialogueUI.open(
      payload,
      (choiceId: number) => this.handleDialogueChoice(choiceId),
      () => this.handleDialogueClose(),
      this.knownWords
    );
  }

  /**
   * Choice Selection Callback: Dispatches DIALOGUE packet via wsClient.
   */
  private handleDialogueChoice(choiceId: number): void {
    const npcId = this.activeNpcId || LAO_WANG_CONFIG.id;
    console.log(`[Main] Dispatching DIALOGUE packet: npc_id='${npcId}', choice_id=${choiceId}`);

    if (this.wsClient) {
      this.wsClient.send('DIALOGUE', {
        npc_id: npcId,
        choice_id: choiceId,
      });
    }
  }

  /**
   * Dialogue closed: restores player controls and clears active NPC.
   */
  private handleDialogueClose(): void {
    console.log('[Main] Dialogue overlay closed. Restoring player movement.');
    this.setModalActive(false);
    this.activeNpcId = null;
  }

  /**
   * Inbound NPC State packet handler. Updates Mianzi & Aggro meters.
   */
  private handleNpcState(payload: NpcStatePayload): void {
    console.log(`[Main] NPC_STATE received: mianzi=${payload.mianzi}, aggro=${payload.aggro}, state=${payload.state}`);

    if (this.dialogueUI && this.dialogueUI.isOpen()) {
      if (typeof this.dialogueUI.updateState === 'function') {
        this.dialogueUI.updateState(payload.mianzi, payload.aggro);
      } else if (typeof (this.dialogueUI as any).updateGauges === 'function') {
        (this.dialogueUI as any).updateGauges(payload.mianzi, payload.aggro);
      }

      // If state signifies dialogue conclusion
      if (payload.state === 'LEAVE' || payload.state === 'EXIT' || payload.state === 'CLOSED') {
        this.dialogueUI.close();
        this.handleDialogueClose();
      }
    }
  }

  /**
   * Evaluates distance between player, Lao Wang (110.0, 0.0, 109.5), and Antique Teapot (110.0, 0.9, 108.5).
   * Toggles interaction prompt [F] or [E] without collision.
   */
  public checkProximity(pos: { x: number; y: number; z: number }): void {
    if (
      this.isModalActive ||
      (this.dialogueUI && this.dialogueUI.isOpen()) ||
      (this.quizPanel && this.quizPanel.isOpen())
    ) {
      if (this.isNearLaoWang || this.isNearTeapot) {
        this.isNearLaoWang = false;
        this.isNearTeapot = false;
        this.hideInteractionPrompt();
      }
      return;
    }

    // Check proximity to original 5_5 landmark OR new central pink square landmark
    const dxLao = pos.x - LAO_WANG_CONFIG.worldPosition.x;
    const dzLao = pos.z - LAO_WANG_CONFIG.worldPosition.z;
    const distSqLao1 = dxLao * dxLao + dzLao * dzLao;

    const dxLao2 = pos.x - LAO_WANG_CONFIG.centralPosition.x;
    const dzLao2 = pos.z - LAO_WANG_CONFIG.centralPosition.z;
    const distSqLao2 = dxLao2 * dxLao2 + dzLao2 * dzLao2;

    const distSqLao = Math.min(distSqLao1, distSqLao2);
    const isNearLao = distSqLao <= LAO_WANG_CONFIG.interactionRadiusSq;

    const dxTea = pos.x - TEAPOT_CONFIG.worldPosition.x;
    const dzTea = pos.z - TEAPOT_CONFIG.worldPosition.z;
    const distSqTea1 = dxTea * dxTea + dzTea * dzTea;

    const dxTea2 = pos.x - TEAPOT_CONFIG.centralPosition.x;
    const dzTea2 = pos.z - TEAPOT_CONFIG.centralPosition.z;
    const distSqTea2 = dxTea2 * dxTea2 + dzTea2 * dzTea2;

    const distSqTea = Math.min(distSqTea1, distSqTea2);
    const isNearTea = distSqTea <= TEAPOT_CONFIG.interactionRadiusSq;

    this.isNearLaoWang = isNearLao;
    this.isNearTeapot = isNearTea;

    if (isNearTea && isNearLao) {
      // Prioritize closest interactable target
      if (distSqTea <= distSqLao) {
        this.showInteractionPrompt(TEAPOT_CONFIG.promptKey, TEAPOT_CONFIG.promptText);
      } else {
        this.showInteractionPrompt(LAO_WANG_CONFIG.promptKey, LAO_WANG_CONFIG.promptText);
      }
    } else if (isNearTea) {
      this.showInteractionPrompt(TEAPOT_CONFIG.promptKey, TEAPOT_CONFIG.promptText);
    } else if (isNearLao) {
      this.showInteractionPrompt(LAO_WANG_CONFIG.promptKey, LAO_WANG_CONFIG.promptText);
    } else {
      this.hideInteractionPrompt();
    }
  }

  public checkNpcProximity(pos: { x: number; y: number; z: number }): void {
    this.checkProximity(pos);
  }

  public showInteractionPrompt(key: string, text: string): void {
    if (!this.interactionPromptEl) return;

    const keyBadge = this.interactionPromptEl.querySelector('.key-badge');
    const promptText = document.getElementById('prompt-text');

    if (keyBadge) {
      keyBadge.textContent = key;
    }
    if (promptText) {
      promptText.textContent = text;
    }

    this.interactionPromptEl.setAttribute('data-key', key);
    this.interactionPromptEl.setAttribute('data-action', text);
    this.interactionPromptEl.setAttribute('data-prompt', `[${key}] ${text}`);
    this.interactionPromptEl.classList.remove('hidden');
  }

  public hideInteractionPrompt(): void {
    if (!this.interactionPromptEl) return;
    this.interactionPromptEl.classList.add('hidden');
  }

  public handleInteractKey(event?: KeyboardEvent): void {
    if (
      this.isModalActive ||
      (this.dialogueUI && this.dialogueUI.isOpen()) ||
      (this.quizPanel && this.quizPanel.isOpen())
    ) {
      return;
    }

    const pos = this.playerController.getPosition();
    const dx1 = pos.x - LAO_WANG_CONFIG.worldPosition.x;
    const dz1 = pos.z - LAO_WANG_CONFIG.worldPosition.z;
    const distSq1 = dx1 * dx1 + dz1 * dz1;

    const dx2 = pos.x - LAO_WANG_CONFIG.centralPosition.x;
    const dz2 = pos.z - LAO_WANG_CONFIG.centralPosition.z;
    const distSq2 = dx2 * dx2 + dz2 * dz2;

    const distSq = Math.min(distSq1, distSq2);

    if (distSq <= LAO_WANG_CONFIG.interactionRadiusSq) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.triggerLaoWangDialogue();
    }
  }

  public handleTeapotKey(event?: KeyboardEvent): void {
    if (
      this.isModalActive ||
      (this.dialogueUI && this.dialogueUI.isOpen()) ||
      (this.quizPanel && this.quizPanel.isOpen())
    ) {
      return;
    }

    const pos = this.playerController.getPosition();
    const dx1 = pos.x - TEAPOT_CONFIG.worldPosition.x;
    const dz1 = pos.z - TEAPOT_CONFIG.worldPosition.z;
    const distSq1 = dx1 * dx1 + dz1 * dz1;

    const dx2 = pos.x - TEAPOT_CONFIG.centralPosition.x;
    const dz2 = pos.z - TEAPOT_CONFIG.centralPosition.z;
    const distSq2 = dx2 * dx2 + dz2 * dz2;

    const distSq = Math.min(distSq1, distSq2);

    if (distSq <= TEAPOT_CONFIG.interactionRadiusSq) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      this.triggerTeapotInspection();
    }
  }

  /**
   * Opens Lao Wang dialogue with initial greeting.
   */
  public triggerLaoWangDialogue(): void {
    console.log('[Main] Opening Lao Wang dialogue via [F] interaction.');

    // 1. MockServer instance
    if (this.mockServer) {
      this.mockServer.triggerLaoWangGreeting();
      return;
    }

    // 2. WSClient Mock mode
    const clientMock = this.wsClient?.getMockServer?.();
    if (clientMock) {
      clientMock.triggerLaoWangGreeting();
      return;
    }

    // 3. Live WebSocket server
    if (this.wsClient && this.wsClient.isConnected) {
      this.wsClient.send('DIALOGUE', {
        npc_id: LAO_WANG_CONFIG.id,
        choice_id: 0,
      });
      return;
    }

    // 4. Standalone fallback (for offline or headless test suites)
    this.openDefaultLaoWangGreeting();
  }

  /**
   * Opens Antique Teapot inspection quiz overlay via [E] interaction.
   */
  public triggerTeapotInspection(): void {
    console.log('[Main] Opening Antique Teapot Quiz via [E] interaction.');

    this.setModalActive(true);
    this.hideInteractionPrompt();

    this.quizPanel.open(
      {
        itemId: TEAPOT_CONFIG.itemId,
        title: TEAPOT_CONFIG.title,
        zh: TEAPOT_CONFIG.zh,
        py: TEAPOT_CONFIG.py,
        question: TEAPOT_CONFIG.question,
        options: TEAPOT_CONFIG.options,
        wordId: TEAPOT_CONFIG.wordId,
      },
      (optionId: number, wordId: string) => {
        this.handleQuizAnswer(optionId, wordId);
      },
      () => {
        this.handleQuizClose();
      }
    );
  }

  private handleQuizAnswer(optionId: number, wordId: string): void {
    console.log(`[Main] Quiz answer submitted: optionId=${optionId}, wordId=${wordId}`);

    if (this.wsClient && this.wsClient.isConnected) {
      this.wsClient.send('INSPECT', {
        item_id: TEAPOT_CONFIG.itemId,
        answer_id: optionId,
      });
    }

    // Standalone fallback: if not connected to live server, dispatch WORD_LEARNED directly
    if (optionId === 1 && (!this.wsClient || !this.wsClient.isConnected)) {
      this.handleWordLearned({
        word_id: TEAPOT_CONFIG.wordId,
        zh: TEAPOT_CONFIG.zh,
        py: TEAPOT_CONFIG.py,
        ru: 'чайник',
      });
    }
  }

  private handleQuizClose(): void {
    console.log('[Main] Quiz panel closed. Restoring player movement.');
    this.setModalActive(false);
  }

  public handleWordLearned(payload: WordLearnedPayload): void {
    console.log(`[Main] WORD_LEARNED received: ${payload.word_id} (${payload.zh} - ${payload.ru})`);
    this.knownWords.add(payload.word_id);

    // Dynamic unmasking: update subtitle tokens in active dialogue if open
    if (this.dialogueUI && this.dialogueUI.isOpen()) {
      this.dialogueUI.refreshSubtitles(this.knownWords);
    }

    // Play Chinese audio pronunciation via TTS
    TTS.speakZh(payload.zh);
  }

  private openDefaultLaoWangGreeting(): void {
    const greeting: NpcSpeechPayload = {
      npc_id: LAO_WANG_CONFIG.id,
      tokens: [
        { id: 'word_hello', zh: '你好', py: 'Nǐ hǎo', ru: 'Привет' },
        { id: 'word_friend', zh: '朋友', py: 'péngyǒu', ru: 'друг' },
        { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
        { id: 'word_this', zh: '这', py: 'Zhè', ru: 'Это' },
        { id: 'word_teapot', zh: '茶壶', py: 'cháhú', ru: 'чайник' },
        { id: 'word_expensive', zh: '太贵了', py: 'tài guì le', ru: 'слишком дорого' },
        { id: 'punct_q', zh: '？', py: '?', ru: '?' },
        { id: 'word_this_is', zh: '这是', py: 'zhè shì', ru: 'это' },
        { id: 'word_authentic', zh: '正宗', py: 'zhèngzōng', ru: 'настоящий' },
        { id: 'word_de', zh: '的', py: 'de', ru: '' },
        { id: 'word_jade', zh: '玉', py: 'yù', ru: 'нефрит' },
        { id: 'punct_excl2', zh: '！', py: '!', ru: '!' },
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

    if (this.wsClient) {
      this.wsClient.dispatch('NPC_SPEECH', greeting);
    } else {
      this.handleNpcSpeech(greeting);
    }
  }

  private animate(currentTime: number): void {
    requestAnimationFrame((t) => this.animate(t));

    const delta = Math.min((currentTime - this.lastTime) / 1000, 0.1);
    this.lastTime = currentTime;

    // 1. Update FPS Diagnostics
    this.frameCount++;
    this.fpsAccumulator += delta;
    if (this.fpsAccumulator >= 0.25) {
      this.currentFps = Math.round(this.frameCount / this.fpsAccumulator);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // 2. Update Controllers & Simulations
    // Sync obstacle collision bounding boxes from active world chunks (excluding player spawn area)
    const walls = this.world.getWallBoundingBoxes?.() ?? [];
    this.playerController.setObstacles(walls);

    this.playerController.update(delta);
    const pos = this.playerController.getPosition();
    this.otherPlayerManager.update(delta);
    this.world.update(delta, pos.x, pos.z);

    // 3. Evaluate NPC Proximity & Interaction Prompt
    this.checkNpcProximity(pos);

    // 4. Render 3D Scene
    this.world.render();

    // 5. Transmit Player Position at ~20 Hz
    this.transmitPositionIfNeeded(delta);

    // 6. Update Real-Time HUD Overlay Every Frame
    const cachePercent = this.world.getCachePercentage?.() ?? 9;
    const chunkCount = this.world.getLoadedChunksCount?.() ?? this.world.getLoadedChunkCount?.() ?? 9;

    this.hud.update(
      this.currentFps,
      cachePercent,
      chunkCount,
      pos.x,
      pos.z,
      this.playerBalance
    );
  }

  private transmitPositionIfNeeded(delta: number): void {
    if (!this.wsClient || !this.wsClient.isConnected) {
      return;
    }

    this.moveAccumulator += delta;
    if (this.moveAccumulator < MOVE_SEND_INTERVAL_SEC) {
      return;
    }
    this.moveAccumulator = 0;

    const pos = this.playerController.getPosition();
    const rot = this.playerController.getRotationY();

    const distSq = (pos.x - this.lastSentX) ** 2 + (pos.z - this.lastSentZ) ** 2;
    const rotDelta = Math.abs(rot - this.lastSentRotation);

    if (distSq > 0.0001 || rotDelta > 0.002) {
      this.wsClient.sendMove({
        x: Number(pos.x.toFixed(3)),
        z: Number(pos.z.toFixed(3)),
        rotation: Number(rot.toFixed(3))
      });

      this.lastSentX = pos.x;
      this.lastSentZ = pos.z;
      this.lastSentRotation = rot;
    }
  }

  // Public Inspection Accessors
  public getDialogueUI(): DialogueUI {
    return this.dialogueUI;
  }

  public getPlayerController(): PlayerController {
    return this.playerController;
  }

  public getWSClient(): WSClient {
    return this.wsClient;
  }

  public isPlayerNearLaoWang(): boolean {
    return this.isNearLaoWang;
  }

  public isInteractionPromptVisible(): boolean {
    return this.interactionPromptEl ? !this.interactionPromptEl.classList.contains('hidden') : false;
  }

  public getInteractionPromptText(): string {
    if (!this.interactionPromptEl) return '';
    const keyBadge = this.interactionPromptEl.querySelector('.key-badge');
    const promptText = document.getElementById('prompt-text');
    const key = keyBadge?.textContent?.trim() ?? 'F';
    const text = promptText?.textContent?.trim() ?? '';
    return `[${key}] ${text}`.trim();
  }

  public getDistanceToLaoWang(): number {
    const pos = this.playerController.getPosition();
    const dx = pos.x - LAO_WANG_CONFIG.worldPosition.x;
    const dz = pos.z - LAO_WANG_CONFIG.worldPosition.z;
    return Math.hypot(dx, dz);
  }

  public getMockServer(): MockServer | null {
    return this.mockServer;
  }

  public getInteractionPrompt(): HTMLElement {
    return this.interactionPromptEl;
  }

  public getQuizPanel(): QuizPanel {
    return this.quizPanel;
  }

  public isPlayerNearTeapot(): boolean {
    return this.isNearTeapot;
  }

  public getKnownWords(): Set<string> {
    return new Set(this.knownWords);
  }

  public getDistanceToTeapot(): number {
    const pos = this.playerController.getPosition();
    const dx = pos.x - TEAPOT_CONFIG.worldPosition.x;
    const dz = pos.z - TEAPOT_CONFIG.worldPosition.z;
    return Math.hypot(dx, dz);
  }
}

// Bootstrap application on DOMContentLoaded
const app = new Application();
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    app.init().catch((err) => {
      console.error('[Main] Critical failure during bootstrap:', err);
    });
  });
}

// Export app instance and Application class for UI modal coordination and testing
export { app, Application };
