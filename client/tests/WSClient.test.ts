import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WSClient } from '../src/net/WSClient';
import {
  MovePayload,
  PlayerMovePayload,
  NpcSpeechPayload,
  WordLearnedPayload,
  BalancePayload,
} from '../src/net/types';

describe('Networking & WSClient Test Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('1. Packet Serialization & Deserialization', () => {
    it('should correctly dispatch valid JSON packets to registered listeners', () => {
      const client = new WSClient({ mock: false, autoReconnect: false });
      const received: PlayerMovePayload[] = [];

      client.on('PLAYER_MOVE', (p) => received.push(p));

      // Simulate incoming message dispatch
      client.dispatch('PLAYER_MOVE', {
        player_id: 42,
        x: 10.5,
        z: 20.2,
        rotation: 1.57,
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        player_id: 42,
        x: 10.5,
        z: 20.2,
        rotation: 1.57,
      });
    });

    it('should allow unsubscribing from packet events', () => {
      const client = new WSClient({ mock: false, autoReconnect: false });
      let callCount = 0;

      const unsubscribe = client.on('BALANCE', () => {
        callCount++;
      });

      client.dispatch('BALANCE', { balance: 100, delta: 0 });
      expect(callCount).toBe(1);

      unsubscribe();
      client.dispatch('BALANCE', { balance: 200, delta: 100 });
      expect(callCount).toBe(1);
    });
  });

  describe('2. 20Hz (~50ms) Move Throttling Engine', () => {
    it('should immediately send first move and throttle subsequent moves within 50ms', () => {
      const client = new WSClient({ mock: false, autoReconnect: false });
      const sentMoves: MovePayload[] = [];

      // Spy on send method
      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') {
          sentMoves.push(payload as MovePayload);
        }
        return true;
      });

      // 1. First move at t = 0ms (should send immediately)
      client.sendMove(10, 20, 0);
      expect(sentMoves).toHaveLength(1);
      expect(sentMoves[0]).toEqual({ x: 10, z: 20, rotation: 0 });

      // 2. Rapid-fire moves within the 50ms window (t = 10ms..40ms)
      client.sendMove(10.5, 20.5, 0.1);
      client.sendMove(11.0, 21.0, 0.2);
      client.sendMove(11.5, 21.5, 0.3); // Final stopping position

      // Must not have sent additional packets yet
      expect(sentMoves).toHaveLength(1);

      // 3. Fast-forward time to t = 50ms
      vi.advanceTimersByTime(50);

      // Trailing-edge flush should have fired with the latest coordinates
      expect(sentMoves).toHaveLength(2);
      expect(sentMoves[1]).toEqual({ x: 11.5, z: 21.5, rotation: 0.3 });
    });

    it('should ignore stationary micro-movements below epsilon', () => {
      const client = new WSClient({ mock: false, autoReconnect: false });
      const sentMoves: MovePayload[] = [];

      vi.spyOn(client, 'send').mockImplementation((type, payload) => {
        if (type === 'MOVE') {
          sentMoves.push(payload as MovePayload);
        }
        return true;
      });

      client.sendMove(50.0, 50.0, 1.0);
      expect(sentMoves).toHaveLength(1);

      // Advance clock past cooldown
      vi.advanceTimersByTime(60);

      // Micro-jitter < 0.001
      client.sendMove(50.0001, 50.0002, 1.00005);
      expect(sentMoves).toHaveLength(1);
    });
  });

  describe('3. Autonomous MockServer Simulation', () => {
    it('should initialize MockServer, emit initial balance and simulate remote bots', () => {
      const client = new WSClient({ mock: true });
      const playerMoves: PlayerMovePayload[] = [];
      let initialBalance: BalancePayload | null = null;

      client.on('BALANCE', (b) => {
        initialBalance = b;
      });
      client.on('PLAYER_MOVE', (p) => {
        playerMoves.push(p);
      });

      client.connect();

      expect(client.isConnected).toBe(true);
      expect(initialBalance).not.toBeNull();
      expect(initialBalance!.balance).toBe(500);

      // Initial bot spawns for bots 101 and 102
      expect(playerMoves.length).toBeGreaterThanOrEqual(2);
      expect(playerMoves.some((p) => p.player_id === 101)).toBe(true);
      expect(playerMoves.some((p) => p.player_id === 102)).toBe(true);

      // Advance time by 200ms (4 bot ticks)
      const countBefore = playerMoves.length;
      vi.advanceTimersByTime(200);
      expect(playerMoves.length).toBeGreaterThan(countBefore);

      client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it('should simulate NPC dialogue tree and state updates on DIALOGUE packet', () => {
      const client = new WSClient({ mock: true });
      let speech: NpcSpeechPayload | null = null;

      client.on('NPC_SPEECH', (s) => {
        speech = s;
      });

      client.connect();

      // Trigger dialogue choice 1: Polite Haggling
      client.send('DIALOGUE', { npc_id: 'lao_wang', choice_id: 1 });

      expect(speech).not.toBeNull();
      expect(speech!.npc_id).toBe('lao_wang');
      expect(speech!.emotion).toBe('HAPPY');
      expect(speech!.mianzi).toBe(50); // initial 40 + 10
      expect(speech!.aggro).toBe(10);  // initial 20 - 10
      expect(speech!.choices?.length).toBeGreaterThan(0);

      client.disconnect();
    });

    it('should simulate item inspection and emit WORD_LEARNED on INSPECT packet', () => {
      const client = new WSClient({ mock: true });
      let learned: WordLearnedPayload | null = null;
      let balanceUpdate: BalancePayload | null = null;

      client.on('WORD_LEARNED', (w) => {
        learned = w;
      });
      client.on('BALANCE', (b) => {
        balanceUpdate = b;
      });

      client.connect();

      // Send correct answer (answer_id: 1) for teapot
      client.send('INSPECT', { item_id: 'item_teapot', answer_id: 1 });

      expect(learned).not.toBeNull();
      expect(learned!.word_id).toBe('word_teapot');
      expect(learned!.zh).toBe('茶壶');
      expect(learned!.ru).toBe('чайник');

      // Check balance reward (+50 ¥)
      expect(balanceUpdate).not.toBeNull();
      expect(balanceUpdate!.balance).toBe(550);
      expect(balanceUpdate!.delta).toBe(50);

      client.disconnect();
    });
  });
});
