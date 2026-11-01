import {
  Packet,
  PlayerMovePayload,
  PlayerJoinPayload,
  NpcSpeechPayload,
  BalancePayload,
  WordLearnedPayload,
} from './types';

interface SimulatedBot {
  id: number;
  name: string;
  x: number;
  z: number;
  rotation: number;
  speed: number;
  minX: number;
  maxX: number;
  direction: number; // 1 or -1
}

export class MockServer {
  private packetListeners = new Set<(packet: Packet) => void>();
  private isRunning = false;
  private simulationTimer: any = null;

  // State caches
  private balance = 500;
  private mianzi = 40; // Respect 0..100
  private aggro = 20;  // Aggro 0..100
  private asyncDelivery = false;

  public setAsyncDelivery(enabled: boolean): void {
    this.asyncDelivery = enabled;
  }

  // 2 Simulated Remote Players for Stage R1
  private bots: SimulatedBot[] = [
    {
      id: 101,
      name: 'Xiao Ming (小明)',
      x: 95,
      z: 100,
      rotation: 0,
      speed: 2.5,
      minX: 85,
      maxX: 115,
      direction: 1,
    },
    {
      id: 102,
      name: 'Mei Mei (美美)',
      x: 105,
      z: 94,
      rotation: Math.PI / 2,
      speed: 1.8,
      minX: 95,
      maxX: 110,
      direction: -1,
    },
  ];

  /**
   * Register a listener for packets sent from MockServer to Client.
   */
  public onPacket(callback: (packet: Packet) => void): () => void {
    this.packetListeners.add(callback);
    return () => this.packetListeners.delete(callback);
  }

  /**
   * Start mock loop and emit initial synchronization packets.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Initial Balance packet
    this.emit('BALANCE', {
      balance: this.balance,
      delta: 0,
    } as BalancePayload);

    // 2. Initial player avatar spawns, with nicknames as the real server sends them
    for (const bot of this.bots) {
      this.emit('PLAYER_JOIN', {
        id: bot.id,
        login: bot.name,
        profile: 'culture',
        x: bot.x,
        z: bot.z,
        rotation: bot.rotation,
      } as PlayerJoinPayload);
      this.emit('PLAYER_MOVE', {
        player_id: bot.id,
        x: bot.x,
        z: bot.z,
        rotation: bot.rotation,
      } as PlayerMovePayload);
    }

    // 3. 20Hz (~50ms) Simulation Loop for Bot Navigation
    const dt = 0.05; // 50ms
    this.simulationTimer = setInterval(() => {
      this.tickBots(dt);
    }, 50);
  }

  /**
   * Halt all simulation timers.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
    this.packetListeners.clear();
  }

  /**
   * Process incoming packet sent from the client.
   */
  public receive(packet: Packet): void {
    if (!this.isRunning) return;

    switch (packet.type) {
      case 'MOVE':
        // Client movement acknowledged (can be used to track proximity)
        break;

      case 'DIALOGUE':
        this.handleDialogue(packet.payload);
        break;

      case 'INSPECT':
        this.handleInspect(packet.payload);
        break;

      case 'PING':
        this.emit('PONG', { fps: 60 });
        break;

      case 'GET_METRICS':
        this.emit('METRICS_UPDATE', {
          users: [
            { player_id: 1, login: 'Admin (You)', fps: 60, ping: 5 },
            { player_id: 2, login: 'Tourist_Alex', fps: 58, ping: 24 },
            { player_id: 3, login: 'Trader_Lin', fps: 61, ping: 18 },
          ],
        });
        break;

      default:
        break;
    }
  }

  /**
   * Trigger Lao Wang's initial greeting speech (useful for testing and proximity interaction).
   */
  public triggerLaoWangGreeting(): void {
    const greeting: NpcSpeechPayload = {
      npc_id: 'lao_wang',
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
      mianzi: this.mianzi,
      aggro: this.aggro,
      price: 500,
    };

    this.emitSpeech(greeting);
  }

  private emitSpeech(speech: NpcSpeechPayload): void {
    // 1. Emit partial chunk immediately (subtitles, gauges, emotion)
    this.emit('NPC_SPEECH_PARTIAL', {
      ...speech,
      choices: [],
      is_partial: true,
    });

    if (this.asyncDelivery && typeof setTimeout !== 'undefined') {
      setTimeout(() => {
        // 2. Emit choices chunk after natural thinking delay
        if (speech.choices && speech.choices.length > 0) {
          this.emit('DIALOGUE_CHOICES', {
            npc_id: speech.npc_id,
            turn_id: speech.turn_id || 'turn_mock',
            choices: speech.choices,
          });
        }
        // 3. Emit full speech for backward compatibility
        this.emit('NPC_SPEECH', speech);
      }, 800);
    } else {
      // 2. Emit choices chunk
      if (speech.choices && speech.choices.length > 0) {
        this.emit('DIALOGUE_CHOICES', {
          npc_id: speech.npc_id,
          turn_id: speech.turn_id || 'turn_mock',
          choices: speech.choices,
        });
      }
      // 3. Emit full speech for backward compatibility with existing tests
      this.emit('NPC_SPEECH', speech);
    }
  }

  private handleDialogue(payload: { npc_id: string; choice_id?: number }): void {
    const choiceId = payload?.choice_id;

    // No choice_id means "start/reopen dialogue": mirror the real server and
    // (re)send the current greeting turn.
    if (choiceId === undefined) {
      this.triggerLaoWangGreeting();
      return;
    }

    this.emit('DIALOGUE_PENDING', { npc_id: payload.npc_id });

    if (choiceId === 1) {
      // Polite Haggling -> Mianzi +10, Aggro -10
      this.mianzi = Math.min(100, this.mianzi + 10);
      this.aggro = Math.max(0, this.aggro - 10);

      this.emitSpeech({
        npc_id: payload.npc_id,
        tokens: [
          { id: 'word_haha', zh: '哈哈', py: 'Hāhā', ru: 'Ха-ха' },
          { id: 'word_polite', zh: '看你懂礼貌', py: 'kàn nǐ dǒng lǐmào', ru: 'вижу ты вежливый' },
          { id: 'punct_comma', zh: '，', py: ',', ru: ',' },
          { id: 'word_discount', zh: '给你打九折', py: 'gěi nǐ dǎ jiǔ zhé', ru: 'даю 10% скидку' },
          { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
        ],
        choices: [
          { id: 10, text_zh: '多谢老板！', text_ru: 'Спасибо, босс!', type: 'polite' },
          { id: 4, text_zh: '我再看看。', text_ru: 'Я ещё посмотрю.', type: 'leave' },
        ],
        emotion: 'HAPPY',
        mianzi: this.mianzi,
        aggro: this.aggro,
        price: 450,
      } as NpcSpeechPayload);
    } else if (choiceId === 2) {
      // Aggressive Haggling -> Aggro +20, Mianzi -5
      this.aggro = Math.min(100, this.aggro + 20);
      this.mianzi = Math.max(0, this.mianzi - 5);

      this.emitSpeech({
        npc_id: payload.npc_id,
        tokens: [
          { id: 'word_three_hundred', zh: '三百', py: 'sānbǎi', ru: 'триста' },
          { id: 'punct_q', zh: '？', py: '?', ru: '?' },
          { id: 'word_joke', zh: '你在开玩笑吗', py: 'nǐ zài kāiwánxiào ma', ru: 'ты шутишь' },
          { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
          { id: 'word_this', zh: '这', py: 'Zhè', ru: 'Это' },
          { id: 'word_authentic', zh: '正宗', py: 'zhèngzōng', ru: 'настоящий' },
          { id: 'word_jade', zh: '玉', py: 'yù', ru: 'нефрит' },
          { id: 'punct_excl2', zh: '！', py: '!', ru: '!' },
        ],
        choices: [
          { id: 1, text_zh: '老板，便宜点吧！', text_ru: 'Босс, сделай скидку!', type: 'polite' },
          { id: 4, text_zh: '太贵了，不要了。', text_ru: 'Слишком дорого, не надо.', type: 'leave' },
        ],
        emotion: 'ANGRY',
        mianzi: this.mianzi,
        aggro: this.aggro,
        price: 480,
      } as NpcSpeechPayload);
    } else if (choiceId === 3) {
      // Provocation ("Fake!") -> Aggro +40, Mianzi -25
      this.aggro = Math.min(100, this.aggro + 40);
      this.mianzi = Math.max(0, this.mianzi - 25);

      this.emitSpeech({
        npc_id: payload.npc_id,
        tokens: [
          { id: 'word_fake', zh: '假货', py: 'jiǎhuò', ru: 'подделка' },
          { id: 'punct_excl', zh: '？！', py: '?!', ru: '?!' },
          { id: 'word_insult', zh: '你敢侮辱我的货品', py: 'nǐ gǎn wǔrǔ wǒ de huòpǐn', ru: 'ты смеешь оскорблять мой товар' },
          { id: 'punct_excl2', zh: '！', py: '!', ru: '!' },
        ],
        choices: [
          { id: 13, text_zh: '息怒，我看错了！', text_ru: 'Не сердитесь, я ошибся!', type: 'polite' },
          { id: 4, text_zh: '哼，走着瞧。', text_ru: 'Хм, увидимся.', type: 'leave' },
        ],
        emotion: 'FURIOUS',
        mianzi: this.mianzi,
        aggro: this.aggro,
      } as NpcSpeechPayload);
    } else if (choiceId === 10) {
      // Purchase completed! Deduct 450 ¥
      this.balance = Math.max(0, this.balance - 450);
      this.emit('BALANCE', { balance: this.balance, delta: -450 });
      this.emitSpeech({
        npc_id: payload.npc_id,
        tokens: [
          { id: 'word_deal', zh: '成交', py: 'Chéngjiāo', ru: 'По рукам' },
          { id: 'punct_excl', zh: '！', py: '!', ru: '!' },
          { id: 'word_thanks', zh: '合作愉快', py: 'hézuò yúkuài', ru: 'приятно иметь дело' },
          { id: 'punct_excl2', zh: '！', py: '!', ru: '!' },
        ],
        choices: [
          { id: 4, text_zh: '谢谢老板，再见！', text_ru: 'Спасибо, босс, до свидания!', type: 'leave' },
        ],
        emotion: 'HAPPY',
        mianzi: this.mianzi,
        aggro: this.aggro,
      } as NpcSpeechPayload);
      this.emit('NPC_STATE', {
        npc_id: payload.npc_id,
        state: 'HAPPY',
        mianzi: this.mianzi,
        aggro: this.aggro,
      });
    } else {
      // Exit or neutral response -> close dialogue cleanly
      this.emit('NPC_STATE', {
        npc_id: payload.npc_id,
        state: 'LEAVE',
        mianzi: this.mianzi,
        aggro: this.aggro,
      });
    }
  }

  private handleInspect(payload: { item_id: string; answer_id: number }): void {
    const { item_id, answer_id } = payload || {};

    // Standard quiz: option 1 is the correct answer
    if (answer_id === 1) {
      let learnedWord: WordLearnedPayload;

      if (item_id === 'item_teapot' || item_id === 'teapot') {
        learnedWord = {
          word_id: 'word_teapot',
          zh: '茶壶',
          py: 'cháhú',
          ru: 'чайник',
        };
      } else if (item_id === 'item_expensive' || item_id === 'expensive') {
        learnedWord = {
          word_id: 'word_expensive',
          zh: '太贵了',
          py: 'tài guì le',
          ru: 'слишком дорого',
        };
      } else {
        learnedWord = {
          word_id: 'word_jade',
          zh: '玉',
          py: 'yù',
          ru: 'нефрит',
        };
      }

      // 1. Emit word learned
      this.emit('WORD_LEARNED', learnedWord);

      // 2. Reward player with +50 ¥
      this.balance += 50;
      this.emit('BALANCE', {
        balance: this.balance,
        delta: 50,
      } as BalancePayload);
    }
  }

  private tickBots(dt: number): void {
    for (const bot of this.bots) {
      bot.x += bot.speed * bot.direction * dt;

      // Reverse direction at boundaries
      if (bot.x >= bot.maxX) {
        bot.x = bot.maxX;
        bot.direction = -1;
        bot.rotation = Math.PI; // Look backward
      } else if (bot.x <= bot.minX) {
        bot.x = bot.minX;
        bot.direction = 1;
        bot.rotation = 0; // Look forward
      }

      this.emit('PLAYER_MOVE', {
        player_id: bot.id,
        x: Number(bot.x.toFixed(3)),
        z: Number(bot.z.toFixed(3)),
        rotation: Number(bot.rotation.toFixed(3)),
      } as PlayerMovePayload);
    }
  }

  private emit<T>(type: string, payload: T): void {
    const packet: Packet<T> = { type, payload };
    this.packetListeners.forEach((listener) => {
      try {
        listener(packet);
      } catch (err) {
        console.error('[MockServer] Error in packet listener:', err);
      }
    });
  }
}
