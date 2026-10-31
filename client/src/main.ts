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
import { AuthScreen } from './ui/AuthScreen';
import {
  AuthClient,
  AuthSession,
  SessionStore,
  browserStorage,
  resolveApiBase,
  wsUrlFor,
} from './net/auth';
import {
  ConnectionClosedPayload,
  NpcSpeechPayload,
  NpcStatePayload,
  PlayerJoinPayload,
  PlayerLeavePayload,
  WelcomePayload,
  WordLearnedPayload,
} from './net/types';

// Network & Transmission Configuration
const MOVE_SEND_INTERVAL_SEC = 0.05; // 20 Hz (50 ms)

// Lao Wang Landmark & Proximity Configuration
export const LAO_WANG_CONFIG = {
  id: 'lao_wang',
  name: 'Лао Ван (老王)',
  // Central pavilion in North Plaza; matches the server catalog entry.
  worldPosition: { x: 100.0, y: 0.0, z: 124.0 },
  chunkCoord: { cx: 5, cz: 6 },
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
  // Teapot on the central pavilion counter.
  worldPosition: { x: 99.2, y: 0.9, z: 124.3 },
  chunkCoord: { cx: 5, cz: 6 },
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

  // Авторизация
  private authClient: AuthClient | null = null;
  private authScreen: AuthScreen | null = null;
  private sessionStore = new SessionStore(browserStorage());
  private session: AuthSession | null = null;

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

  // Obstacle Collision Caching
  private lastSyncedObstacles: any = null;

  // Modal Lock & Interaction State
  private isModalActive = false;
  private isNearLaoWang = false;
  private isNearTeapot = false;
  private isDialogueActive = false;
  private activeNpcId: string | null = null;
  private activeTurnId: string | null = null;
  private speechDismissTimeout: number | null = null;
  private lastNpcSpeech: Record<string, NpcSpeechPayload> = {};

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

    // 6. Авторизованная сессия: актуальное состояние игрока от сервера
    client.on('WELCOME', (payload: WelcomePayload) => {
      this.applyPlayerState(payload.player, payload.known_words, true);
    });

    // 7. Другие игроки появляются и уходят из зоны видимости
    client.on('PLAYER_JOIN', (payload: PlayerJoinPayload) => {
      this.otherPlayerManager.updatePlayer({
        player_id: payload.id,
        x: payload.x,
        z: payload.z,
        rotation: payload.rotation,
      });
    });
    client.on('PLAYER_LEAVE', (payload: PlayerLeavePayload) => {
      this.otherPlayerManager.removePlayer(payload.player_id);
    });

    // 8. Сервер закрыл соединение: 1008 = этот аккаунт уже в игре
    client.on('CONNECTION_CLOSED', (payload: ConnectionClosedPayload) => {
      if (payload.code === 1008) {
        void this.handleSessionRejected(
          'Этот аккаунт уже в игре на другом устройстве. Войдите под другим логином.'
        );
      }
    });

    client.on('ERROR', (payload) => {
      console.warn('[Main] Server error:', payload?.code ?? payload);
    });
  }

  private async initNetworking(): Promise<void> {
    const urlParams = new URLSearchParams(window.location.search);
    const forceMock = urlParams.get('mock') === 'true' || urlParams.get('demo') === 'true';

    if (forceMock) {
      this.activateMockServer();
      return;
    }

    this.authClient = new AuthClient(resolveApiBase(window.location));
    this.authScreen = new AuthScreen(this.authClient);
    this.bindLogout();
    await this.startOnlineSession(this.sessionStore.load());
  }

  /**
   * Вход в мир: сохранённая сессия или экран входа -> WebSocket с токеном.
   * Повторяется, пока игрок не войдёт или не выберет демо-режим.
   */
  private async startOnlineSession(saved: AuthSession | null, notice?: string): Promise<void> {
    const authClient = this.authClient!;
    const authScreen = this.authScreen!;
    let session = saved;
    let message = notice;

    for (;;) {
      if (!session) {
        this.setModalActive(true);
        const result = await authScreen.show(message);
        if (result.kind === 'offline') {
          authScreen.hide();
          this.setModalActive(false);
          this.activateMockServer();
          return;
        }
        session = result.session;
        this.sessionStore.save(session);
      }

      authScreen.showConnecting();
      if (await this.connectWithSession(session)) {
        authScreen.hide();
        this.setModalActive(false);
        this.hud.showToast(`Добро пожаловать, ${session.player.login}!`);
        return;
      }

      // Не подключились: токен устарел или сервер недоступен.
      this.sessionStore.clear();
      this.session = null;
      session = null;
      message = (await authClient.health())
        ? 'Сессия устарела. Войдите снова.'
        : 'Не удалось подключиться к серверу. Проверьте, что он запущен, или играйте в демо-режиме.';
    }
  }

  private async connectWithSession(session: AuthSession): Promise<boolean> {
    const authClient = this.authClient!;
    this.wsClient?.disconnect();

    const client = new WSClient({ url: wsUrlFor(authClient.apiBase, session.token), mock: false });
    this.wsClient = client;
    this.wireNetworkHandlers(client);
    this.applyPlayerState(session.player, session.knownWords, false);

    try {
      await client.connect();
      this.session = session;
      this.hud.setWsStatus('connected');
      this.setAuthStatus(session.player.login);
      console.log(`[Main] Connected as '${session.player.login}' to ${authClient.apiBase}`);
      return true;
    } catch (err) {
      console.warn('[Main] Authenticated WebSocket connection failed:', err);
      client.disconnect();
      this.hud.setWsStatus('disconnected');
      return false;
    }
  }

  /** Применяет позицию, баланс и словарь игрока (из ответа входа или WELCOME). */
  private applyPlayerState(
    player: { login: string; x: number; z: number; balance: number },
    knownWords: string[],
    moveToServerPosition: boolean
  ): void {
    this.playerBalance = player.balance;
    this.hud.updateBalance(player.balance);
    this.knownWords = new Set(knownWords);
    if (moveToServerPosition) {
      const current = this.playerController.getPosition();
      this.playerController.setPosition(player.x, current.y, player.z);
    }
    if (this.dialogueUI && this.dialogueUI.isOpen()) {
      this.dialogueUI.refreshSubtitles(this.knownWords);
    }
  }

  /** Сервер отклонил сессию во время игры: возвращаемся к экрану входа. */
  private async handleSessionRejected(message: string): Promise<void> {
    this.sessionStore.clear();
    this.session = null;
    this.setAuthStatus(null);
    this.otherPlayerManager.clear();
    this.playerController.exitPointerLock();
    this.setModalActive(true);
    this.hud.setWsStatus('disconnected');
    if (this.authClient && this.authScreen && !this.authScreen.isVisible()) {
      await this.startOnlineSession(null, message);
    }
  }

  /** Строка «Вы вошли как …» и кнопка «Выйти» на стартовом экране. */
  private setAuthStatus(login: string | null): void {
    const box = document.getElementById('auth-status');
    const name = document.getElementById('auth-status-login');
    if (!box || !name) return;
    name.textContent = login ?? '';
    box.classList.toggle('hidden', !login);
  }

  private bindLogout(): void {
    const button = document.getElementById('logout-btn');
    button?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation(); // не запрашивать pointer lock у подложки
      this.sessionStore.clear();
      this.wsClient?.disconnect();
      window.location.reload();
    });
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
    this.blockerEl.addEventListener('click', (event: MouseEvent) => {
      if (event?.target && (event.target as HTMLElement).closest('button, input, a, select')) {
        return;
      }
      if (this.authScreen?.isVisible()) {
        return;
      }
      if (!this.isModalActive && !this.dialogueUI?.isOpen() && !this.quizPanel?.isOpen()) {
        this.playerController.requestPointerLock();
      }
    });

    this.playerController.onLock(() => {
      this.blockerEl.classList.add('hidden');
    });

    this.playerController.onUnlock(() => {
      if (!this.isModalActive && !this.isDialogueActive && !this.authScreen?.isVisible() && !this.dialogueUI?.isOpen() && !this.quizPanel?.isOpen()) {
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
      // Closing a modal in-game must not pop up the Esc instructions blocker
      this.blockerEl.classList.add('hidden');
    }
  }

  /**
   * Inbound NPC Speech packet handler. Caches speech and only opens DialogueUI
   * if the user actively initiated dialogue via [F] or is currently in an active conversation.
   */
  private handleNpcSpeech(payload: NpcSpeechPayload): void {
    console.log(`[Main] NPC speech received from '${payload.npc_id}' (${payload.tokens?.length ?? 0} tokens)`);
    this.lastNpcSpeech[payload.npc_id] = payload;
    this.activeNpcId = payload.npc_id;
    this.activeTurnId = payload.turn_id ?? null;

    // Approaching an NPC must NEVER automatically open dialogue or break pointer lock!
    // Dialogue should ONLY open when the player presses [F] or is continuing an active dialogue.
    if (!this.isDialogueActive) {
      return;
    }

    this.openInteractiveDialogue(payload);
  }

  private openInteractiveDialogue(payload: NpcSpeechPayload): void {
    const hasChoices = Array.isArray(payload.choices) && payload.choices.length > 0;
    const isInteractive = hasChoices && Boolean(payload.turn_id);

    // 1. Only activate UI modal lock (frees mouse pointer, suspends WASD) if there are interactive choices!
    if (isInteractive) {
      this.setModalActive(true);
    } else {
      this.setModalActive(false);
    }

    // 2. Hide proximity prompt
    this.hideInteractionPrompt();

    // 3. Play TTS audio from AI service (Base64 WAV)
    if (payload.audio_base64) {
      try {
        const binary = atob(payload.audio_base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch((err) => console.warn('[Main] TTS audio play failed:', err));
        console.log(`[Main] Playing TTS audio (${bytes.length} bytes) for NPC '${payload.npc_id}'`);
      } catch (err) {
        console.warn('[Main] Failed to decode/play TTS audio:', err);
      }
    }

    // 4. Open DialogueUI
    this.dialogueUI.open(
      payload,
      (choiceId: number) => this.handleDialogueChoice(choiceId),
      () => this.handleDialogueClose(),
      this.knownWords
    );
  }

  /**
   * Choice Selection Callback: Dispatches DIALOGUE packet via wsClient.
   * Includes turn_id to prevent STALE_CHOICE errors on server.
   */
  private handleDialogueChoice(choiceId: number): void {
    const npcId = this.activeNpcId || LAO_WANG_CONFIG.id;
    console.log(`[Main] Dispatching DIALOGUE packet: npc_id='${npcId}', choice_id=${choiceId}, turn_id='${this.activeTurnId}'`);

    if (this.wsClient) {
      this.wsClient.send('DIALOGUE', {
        npc_id: npcId,
        choice_id: choiceId,
        ...(this.activeTurnId ? { turn_id: this.activeTurnId } : {}),
      });
    }
  }

  /**
   * Dialogue closed: restores player controls, resets active dialogue flag and clears active NPC.
   */
  private handleDialogueClose(): void {
    console.log('[Main] Dialogue overlay closed. Restoring player movement.');
    this.isDialogueActive = false;
    this.setModalActive(false);
    this.activeNpcId = null;
    this.activeTurnId = null;
    if (this.speechDismissTimeout !== null) {
      window.clearTimeout(this.speechDismissTimeout);
      this.speechDismissTimeout = null;
    }
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
   * Evaluates distance between player, Lao Wang (100.0, 0.0, 124.0), and Antique Teapot (99.2, 0.9, 124.3).
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

    // Both interactables live at the central pavilion, matching the server.
    const dxLao = pos.x - LAO_WANG_CONFIG.worldPosition.x;
    const dzLao = pos.z - LAO_WANG_CONFIG.worldPosition.z;
    const distSqLao = dxLao * dxLao + dzLao * dzLao;
    const isNearLao = distSqLao <= LAO_WANG_CONFIG.interactionRadiusSq;

    const dxTea = pos.x - TEAPOT_CONFIG.worldPosition.x;
    const dzTea = pos.z - TEAPOT_CONFIG.worldPosition.z;
    const distSqTea = dxTea * dxTea + dzTea * dzTea;
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
    const dx = pos.x - LAO_WANG_CONFIG.worldPosition.x;
    const dz = pos.z - LAO_WANG_CONFIG.worldPosition.z;
    const distSq = dx * dx + dz * dz;

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
    const dx = pos.x - TEAPOT_CONFIG.worldPosition.x;
    const dz = pos.z - TEAPOT_CONFIG.worldPosition.z;
    const distSq = dx * dx + dz * dz;

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
    this.isDialogueActive = true;

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

    // 3. Live WebSocket server.
    // Start/reopen the dialogue without choice_id: the server generates (or
    // resends) the current turn and returns it together with a fresh turn_id.
    if (this.wsClient && this.wsClient.isConnected) {
      this.wsClient.send('DIALOGUE', {
        npc_id: LAO_WANG_CONFIG.id,
      });

      // If we already received recent speech from syncScenes, show it immediately
      if (this.lastNpcSpeech[LAO_WANG_CONFIG.id]) {
        this.openInteractiveDialogue(this.lastNpcSpeech[LAO_WANG_CONFIG.id]);
      }
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
    // Sync obstacle collision bounding boxes from active world chunks (cached, only recomputed when chunks load/unload)
    const walls = this.world.getWallBoundingBoxes?.() ?? [];
    if (walls !== this.lastSyncedObstacles) {
      this.lastSyncedObstacles = walls;
      this.playerController.setObstacles(walls);
    }

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
  /** Текущая авторизованная сессия (null в демо-режиме или до входа). */
  public getSession(): AuthSession | null {
    return this.session;
  }

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
