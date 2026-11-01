/**
 * Network protocol types and packet contracts for Rest-In-Hackaton.
 * Conforms to both client-side Three.js engine and Go WebSocket backend specifications.
 */

export type PacketType =
  | 'MOVE'
  | 'PLAYER_MOVE'
  | 'PLAYER_LEAVE'
  | 'DIALOGUE'
  | 'DIALOGUE_PENDING'
  | 'DIALOGUE_CHOICES'
  | 'NPC_SPEECH'
  | 'NPC_SPEECH_PARTIAL'
  | 'NPC_STATE'
  | 'INSPECT'
  | 'WORD_LEARNED'
  | 'BALANCE'
  | 'CHUNK_LOAD'
  | 'CHUNK_UNLOAD'
  | 'CALCULATOR'
  | 'ERROR'
  | 'PING'
  | 'PONG'
  | 'WELCOME'
  | 'PLAYER_JOIN'
  | 'WORLD_EDIT'
  | 'CONNECTION_CLOSED';

export interface Packet<T = any> {
  type: PacketType | string;
  payload: T;
}

// -------------------------------------------------------------
// Client -> Server Payloads
// -------------------------------------------------------------

export interface MovePayload {
  x: number;
  z: number;
  rotation: number; // yaw rotation in radians
}

export interface DialoguePayload {
  npc_id: string;
  // Omitted when starting/reopening a dialogue: the server then generates or
  // resends the current turn. Must be paired with turn_id when choosing.
  choice_id?: number;
  turn_id?: string;
}

export interface InspectPayload {
  item_id: string;
  answer_id: number;
}

export interface CalculatorPayload {
  npc_id: string;
  amount: number;
}

// -------------------------------------------------------------
// Server -> Client Payloads
// -------------------------------------------------------------

export interface PlayerMovePayload {
  player_id: number;
  x: number;
  z: number;
  rotation: number;
}

export interface PlayerLeavePayload {
  player_id: number;
}

export interface Token {
  id?: string;     // Unique token identifier, e.g. "word_expensive"
  zh: string;     // Chinese character(s), e.g. "太贵了"
  py: string;     // Pinyin transcription, e.g. "tài guì le"
  ru: string;     // Russian translation, e.g. "слишком дорого"
}

export interface Choice {
  id: number;
  // Server shape (see server/internal/game Choice).
  zh?: string;
  py?: string;
  ru?: string;
  // Legacy/mock shape kept for MockServer and fixtures.
  text_zh?: string;
  text_ru?: string;
  text_py?: string;
  type?: 'polite' | 'haggle' | 'provoke' | 'leave' | 'bluff' | 'order' | 'documents' | 'bribe' | 'directions';
}

export interface NpcSpeechPayload {
  npc_id: string;
  tokens: Token[];
  choices?: Choice[];
  emotion?: string; // "NEUTRAL" | "HAPPY" | "ANGRY" | "FURIOUS"
  mianzi: number;  // Respect meter: 0..100
  aggro: number;   // Aggro / Rage meter: 0..100
  stall_closed?: boolean;
  price?: number;
  audio_base64?: string; // Base64-encoded WAV audio from AI TTS
  turn_id?: string;      // Turn token for STALE_CHOICE guard
  is_partial?: boolean;
}

export interface DialoguePendingPayload {
  npc_id: string;
  player_id?: number;
}

export interface DialogueChoicesPayload {
  npc_id: string;
  turn_id: string;
  choices: Choice[];
}

export interface NpcStatePayload {
  npc_id: string;
  state: string;
  mianzi: number;
  aggro: number;
  personal_aggro?: number;
  stall_closed?: boolean;
}

export interface WordLearnedPayload {
  word_id: string;
  zh: string;
  py?: string;
  ru: string;
}

export interface BalancePayload {
  balance: number;
  delta?: number;
}

export interface ChunkLoadPayload {
  chunk_id: string;
  revision?: number;
  buildings?: Array<{type: string; x: number; z: number}>;
  signs?: Array<{text: string; x: number; y: number; z: number}>;
  objects?: any[];
  lanterns?: Array<{ x: number; y: number; z: number }>;
  npc_id?: string;
  /** Coordinates are local to the chunk (0–20); add (xIndex*20, zIndex*20) for world space. */
  npcs?: Array<{ npc_id: string; x: number; y: number; z: number }>;
  items?: Array<{ item_id: string; x: number; y: number; z: number }>;
}

export interface ChunkUnloadPayload {
  chunk_ids: string[];
}

/** Первое сообщение сервера после подключения: актуальное состояние игрока. */
export interface WelcomePayload {
  player: {
    id: number;
    login: string;
    profile: string;
    x: number;
    z: number;
    rotation: number;
    balance: number;
  };
  known_words: string[];
  inventory: Array<{ item_id: string; price_paid: number }>;
  world?: { total_chunks: number; total_bytes: number; chunk_size: number; max_percent: number };
}

/** Другой игрок появился в зоне видимости. Баланс не приходит: кошелёк виден только владельцу. */
export interface PlayerJoinPayload {
  id: number;
  login: string;
  profile: string;
  x: number;
  z: number;
  rotation: number;
}

/**
 * Редактор уровней сохранил чанки. Клиент → сервер: {chunk_ids};
 * сервер → остальные игроки: {chunk_ids, player_id, login}.
 */
export interface WorldEditPayload {
  chunk_ids: string[];
  player_id?: number;
  login?: string;
}

/** Локальное событие WSClient: соединение закрыто (code 1008 — аккаунт уже в игре). */
export interface ConnectionClosedPayload {
  code: number;
  reason: string;
}

export interface ErrorPayload {
  message?: string;
  code?: string;
}

// -------------------------------------------------------------
// Type Mapping Table for Compile-Time Safety
// -------------------------------------------------------------

export interface PacketMap {
  MOVE: MovePayload;
  PLAYER_MOVE: PlayerMovePayload;
  PLAYER_LEAVE: PlayerLeavePayload;
  DIALOGUE: DialoguePayload;
  NPC_SPEECH: NpcSpeechPayload;
  NPC_STATE: NpcStatePayload;
  INSPECT: InspectPayload;
  WORD_LEARNED: WordLearnedPayload;
  BALANCE: BalancePayload;
  CHUNK_LOAD: ChunkLoadPayload;
  CHUNK_UNLOAD: ChunkUnloadPayload;
  CALCULATOR: CalculatorPayload;
  ERROR: ErrorPayload;
  PING: Record<string, never>;
  PONG: Record<string, never>;
  WELCOME: WelcomePayload;
  PLAYER_JOIN: PlayerJoinPayload;
  WORLD_EDIT: WorldEditPayload;
  CONNECTION_CLOSED: ConnectionClosedPayload;
}

// -------------------------------------------------------------
// Connection & Configuration Models
// -------------------------------------------------------------

export type ConnectionState = 'connecting' | 'open' | 'closing' | 'closed';

export interface WSClientConfig {
  url?: string;
  mock?: boolean;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectInterval?: number;
  reconnectDecay?: number;
  maxReconnectAttempts?: number;
  moveThrottleMs?: number; // default: 50ms (~20Hz)
  moveEpsilon?: number;    // default: 0.001 units
}
