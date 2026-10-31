import {
  Packet,
  PacketMap,
  MovePayload,
  ConnectionState,
  WSClientConfig,
} from './types';
import { MockServer } from './MockServer';

export type PacketHandler<T = any> = (payload: T) => void;
export type ConnectionStateListener = (state: ConnectionState) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private mockServer: MockServer | null = null;
  private isMock: boolean = false;
  private config: Required<WSClientConfig>;

  private listeners = new Map<string, Set<PacketHandler>>();
  private connectionStateListeners = new Set<ConnectionStateListener>();
  private currentState: ConnectionState = 'closed';

  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private isExplicitlyClosed = false;

  // 20Hz Throttling State (~50ms)
  private lastMoveSentTime = 0;
  private pendingMove: MovePayload | null = null;
  private throttleTimer: any = null;
  private lastSentMove: MovePayload | null = null;

  constructor(configOrUrl?: string | WSClientConfig) {
    const isUrl = typeof configOrUrl === 'string';
    const rawConfig: WSClientConfig = isUrl
      ? { url: configOrUrl }
      : (configOrUrl || {});

    // Check URL query params for ?mock=true fallback in browser
    let queryMock = false;
    if (typeof window !== 'undefined' && window.location && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      queryMock = params.get('mock') === 'true' || params.get('demo') === 'true';
    }

    this.config = {
      url: rawConfig.url ?? 'ws://localhost:3000/ws',
      mock: rawConfig.mock ?? queryMock,
      autoReconnect: rawConfig.autoReconnect ?? true,
      reconnectInterval: rawConfig.reconnectInterval ?? 1000,
      maxReconnectInterval: rawConfig.maxReconnectInterval ?? 10000,
      reconnectDecay: rawConfig.reconnectDecay ?? 1.5,
      maxReconnectAttempts: rawConfig.maxReconnectAttempts ?? 10,
      moveThrottleMs: rawConfig.moveThrottleMs ?? 50, // 20Hz
      moveEpsilon: rawConfig.moveEpsilon ?? 0.001,
    };

    this.isMock = this.config.mock;
  }

  public get state(): ConnectionState {
    return this.currentState;
  }

  public get isConnected(): boolean {
    return this.currentState === 'open';
  }

  public get isMockMode(): boolean {
    return this.isMock;
  }

  /**
   * Connect to server or initialize mock engine.
   * Returns a Promise that resolves when connection is open, or immediately in mock mode.
   */
  public connect(): Promise<void> {
    this.isExplicitlyClosed = false;

    if (this.isMock) {
      this.initMockServer();
      return Promise.resolve();
    }

    if (typeof WebSocket === 'undefined') {
      console.warn('[WSClient] Native WebSocket unavailable, falling back to MockServer.');
      this.isMock = true;
      this.initMockServer();
      return Promise.resolve();
    }

    this.setConnectionState('connecting');

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled && this.currentState !== 'open') {
          settled = true;
          this.setConnectionState('closed');
          reject(new Error('[WSClient] Connection timeout'));
        }
      }, 3000);

      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.onopen = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.reconnectAttempts = 0;
            this.setConnectionState('open');
            resolve();
          }
        };

        this.ws.onmessage = (event: MessageEvent) => {
          this.handleIncomingRaw(event.data);
        };

        this.ws.onerror = (err: Event) => {
          console.warn('[WSClient] WebSocket error encountered:', err);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.setConnectionState('closed');
            reject(new Error('[WSClient] WebSocket connection error'));
          }
        };

        this.ws.onclose = (event?: { code?: number; reason?: string }) => {
          const code = event?.code ?? 1006;
          const reason = event?.reason ?? '';
          // 1008 = сервер отклонил сессию (аккаунт уже в игре). Переподключение бессмысленно.
          if (code === 1008) {
            this.isExplicitlyClosed = true;
          }
          this.setConnectionState('closed');
          this.dispatch('CONNECTION_CLOSED', { code, reason });
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('[WSClient] WebSocket closed before open'));
          }
          if (!this.isExplicitlyClosed && this.config.autoReconnect) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.setConnectionState('closed');
          reject(err);
        }
        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      }
    });
  }

  /**
   * Explicitly disconnect and cleanup resources.
   */
  public disconnect(): void {
    this.isExplicitlyClosed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    if (this.mockServer) {
      this.mockServer.stop();
      this.mockServer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.setConnectionState('closed');
  }

  /**
   * Send a strongly-typed packet envelope.
   */
  public send<K extends keyof PacketMap>(type: K, payload: PacketMap[K]): boolean;
  public send(type: string, payload: any): boolean;
  public send(type: string, payload: any): boolean {
    const packet: Packet = { type, payload };

    if (this.isMock && this.mockServer) {
      this.mockServer.receive(packet);
      return true;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(packet));
      return true;
    }

    return false;
  }

  /**
   * Transmit player movement throttled to ~20Hz (50ms interval).
   * Employs leading-edge immediate dispatch and trailing-edge final flush.
   */
  public sendMove(payload: MovePayload, force?: boolean): void;
  public sendMove(x: number, z: number, rotation: number, force?: boolean): void;
  public sendMove(
    xOrPayload: number | MovePayload,
    zOrForce?: number | boolean,
    rotation?: number,
    force: boolean = false
  ): void {
    let x: number;
    let z: number;
    let rot: number;
    let isForced: boolean;

    if (typeof xOrPayload === 'object' && xOrPayload !== null) {
      x = xOrPayload.x;
      z = xOrPayload.z;
      rot = xOrPayload.rotation;
      isForced = typeof zOrForce === 'boolean' ? zOrForce : false;
    } else {
      x = xOrPayload;
      z = typeof zOrForce === 'number' ? zOrForce : 0;
      rot = rotation ?? 0;
      isForced = force;
    }

    // Epsilon check: ignore micro-jitters when stationary
    if (!isForced && this.lastSentMove) {
      const dx = Math.abs(x - this.lastSentMove.x);
      const dz = Math.abs(z - this.lastSentMove.z);
      const dRot = Math.abs(rot - this.lastSentMove.rotation);
      if (
        dx < this.config.moveEpsilon &&
        dz < this.config.moveEpsilon &&
        dRot < this.config.moveEpsilon
      ) {
        return;
      }
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = now - this.lastMoveSentTime;

    if (isForced || elapsed >= this.config.moveThrottleMs) {
      // Immediate transmission (leading edge or cooldown expired)
      if (this.throttleTimer) {
        clearTimeout(this.throttleTimer);
        this.throttleTimer = null;
      }
      this.pendingMove = null;
      this.lastMoveSentTime = now;
      this.lastSentMove = { x, z, rotation: rot };
      this.send('MOVE', { x, z, rotation: rot });
    } else {
      // Buffer the move and ensure trailing-edge flush for the stopping position
      this.pendingMove = { x, z, rotation: rot };
      if (!this.throttleTimer) {
        const delay = Math.max(0, this.config.moveThrottleMs - elapsed);
        this.throttleTimer = setTimeout(() => {
          this.throttleTimer = null;
          if (this.pendingMove) {
            const moveToSend = this.pendingMove;
            this.pendingMove = null;
            this.lastMoveSentTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this.lastSentMove = moveToSend;
            this.send('MOVE', moveToSend);
          }
        }, delay);
      }
    }
  }

  /**
   * Subscribe to strongly-typed incoming packet events.
   * Returns an unsubscribe callback for easy cleanup.
   */
  public on<K extends keyof PacketMap>(
    type: K,
    handler: (payload: PacketMap[K]) => void
  ): () => void;
  public on(type: string, handler: (payload: any) => void): () => void;
  public on(type: string, handler: (payload: any) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(handler);
    return () => this.off(type, handler);
  }

  /**
   * Remove a registered packet event handler.
   */
  public off(type: string, handler: PacketHandler): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  /**
   * Register a connection state change listener.
   */
  public onConnectionChange(listener: ConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    listener(this.currentState);
    return () => this.connectionStateListeners.delete(listener);
  }

  /**
   * Manual dispatch method used by MockServer or testing bridges.
   */
  public dispatch(type: string, payload: any): void {
    const handlers = this.listeners.get(type);
    if (handlers) {
      handlers.forEach((h) => {
        try {
          h(payload);
        } catch (err) {
          console.error(`[WSClient] Error in '${type}' handler:`, err);
        }
      });
    }
  }

  public getMockServer(): MockServer | null {
    return this.mockServer;
  }

  private handleIncomingRaw(data: any): void {
    try {
      const text = typeof data === 'string' ? data : data.toString();
      const packet: Packet = JSON.parse(text);
      if (!packet || typeof packet.type !== 'string') {
        console.warn('[WSClient] Invalid packet envelope structure:', data);
        return;
      }
      this.dispatch(packet.type, packet.payload);
    } catch (err) {
      console.error('[WSClient] Failed to deserialize incoming message:', err);
    }
  }

  private setConnectionState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    this.connectionStateListeners.forEach((listener) => {
      try {
        listener(state);
      } catch (err) {
        console.error('[WSClient] Error in connection state listener:', err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.warn('[WSClient] Max reconnect attempts reached. Please sign in again.');
      this.setConnectionState('closed');
      return;
    }

    const baseDelay = this.config.reconnectInterval * Math.pow(this.config.reconnectDecay, this.reconnectAttempts);
    const cappedDelay = Math.min(baseDelay, this.config.maxReconnectInterval);
    const jitter = cappedDelay * 0.2 * Math.random();
    const finalDelay = Math.round(cappedDelay + jitter);

    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      if (!this.isExplicitlyClosed) {
        this.connect().catch((err) => {
          console.warn('[WSClient] Reconnect attempt failed:', err);
        });
      }
    }, finalDelay);
  }

  private initMockServer(): void {
    if (this.mockServer) {
      this.mockServer.stop();
    }
    this.mockServer = new MockServer();
    this.mockServer.onPacket((packet) => {
      this.dispatch(packet.type, packet.payload);
    });
    this.mockServer.start();
    this.setConnectionState('open');
  }
}
