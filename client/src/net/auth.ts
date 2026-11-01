/**
 * Авторизация и регистрация игрока.
 *
 * Сервер (server/internal/handler/http.go) отдаёт:
 *   POST /auth/register {login,password,profile} -> 201 {token,expires_at,player,known_words,inventory}
 *   POST /auth/login    {login,password}         -> 200 тот же ответ
 *   GET  /health                                   -> 200 {status:"ok"}
 * Ошибки приходят как {"error":"CODE"}. Токен (JWT, 8 часов) передаётся в WebSocket как /ws?token=...
 * Правила полей совпадают с серверными: логин 3–32 символа после trim, пароль 8–72 байта.
 */

export type Profile = 'business' | 'culture';
export type AuthMode = 'login' | 'register';

export interface AuthPlayer {
  id: number;
  login: string;
  profile: string;
  x: number;
  z: number;
  rotation: number;
  balance: number;
  isAdmin: boolean;
}

export interface AuthItem {
  item_id: string;
  price_paid: number;
}

export interface AuthSession {
  token: string;
  expiresAt: string; // RFC 3339, как в ответе сервера
  player: AuthPlayer;
  knownWords: string[];
  inventory: AuthItem[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const LOGIN_MIN = 3;
export const LOGIN_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72;
export const DEFAULT_API_PORT = '3000';

/** Сообщения для кодов ошибок сервера и сети. */
const MESSAGES: Record<string, string> = {
  LOGIN_TAKEN: 'Этот логин уже занят. Выберите другой или войдите.',
  INVALID_PROFILE: 'Выберите профиль игрока.',
  INVALID_REQUEST: 'Сервер не понял запрос. Обновите страницу.',
  ORIGIN_DENIED:
    'Сервер не принимает подключения с этого адреса. Добавьте его в ALLOWED_ORIGINS на сервере.',
  DB_ERROR: 'Ошибка базы данных на сервере. Попробуйте ещё раз.',
  AUTH_ERROR: 'Ошибка на сервере. Попробуйте ещё раз.',
  DB_UNAVAILABLE: 'База данных недоступна. Проверьте, что PostgreSQL запущен.',
  NETWORK:
    'Сервер недоступен. Проверьте, что он запущен и адрес этой страницы есть в ALLOWED_ORIGINS.',
  BAD_RESPONSE: 'Сервер ответил в неожиданном формате.',
};

export class AuthError extends Error {
  constructor(public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'AuthError';
  }
}

/** Человекочитаемое сообщение для кода ошибки. */
export function messageForError(code: string, mode: AuthMode): string {
  if (code === 'INVALID_CREDENTIALS') {
    // Сервер отдаёт этот код и на неверный пароль, и на нарушение длины полей.
    return mode === 'login'
      ? 'Неверный логин или пароль.'
      : `Логин — от ${LOGIN_MIN} до ${LOGIN_MAX} символов, пароль — от ${PASSWORD_MIN} до ${PASSWORD_MAX} символов.`;
  }
  return MESSAGES[code] ?? `Не удалось выполнить запрос (${code}).`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Проверка полей до отправки на сервер. Возвращает текст ошибки или null. */
export function validateCredentials(
  mode: AuthMode,
  login: string,
  password: string,
  confirm?: string
): string | null {
  const trimmed = login.trim();
  const loginLength = [...trimmed].length;
  if (loginLength < LOGIN_MIN || loginLength > LOGIN_MAX) {
    return `Логин должен содержать от ${LOGIN_MIN} до ${LOGIN_MAX} символов.`;
  }
  const bytes = byteLength(password);
  if (bytes < PASSWORD_MIN) {
    return `Пароль должен содержать не меньше ${PASSWORD_MIN} символов.`;
  }
  if (bytes > PASSWORD_MAX) {
    return `Пароль слишком длинный: максимум ${PASSWORD_MAX} байт.`;
  }
  if (mode === 'register' && confirm !== undefined && confirm !== password) {
    return 'Пароли не совпадают.';
  }
  return null;
}

/** Адрес REST API: тот же хост, что у страницы; на HTTPS порт опускается, на HTTP по умолчанию 3000 (или ?api_port= / ?ws_port=). */
export function resolveApiBase(loc: { protocol?: string; hostname?: string; port?: string; search?: string }): string {
  const params = new URLSearchParams(loc.search ?? '');
  const overridePort = params.get('api_port') || params.get('ws_port');
  const scheme = loc.protocol === 'https:' ? 'https' : (loc.protocol ? loc.protocol.replace(':', '') : 'http');
  const host = loc.hostname || 'localhost';
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  if (overridePort) {
    return `${scheme}://${hostPart}:${overridePort}`;
  }

  if (scheme === 'https') {
    if (loc.port && loc.port !== '443') {
      return `${scheme}://${hostPart}:${loc.port}`;
    }
    return `${scheme}://${hostPart}`;
  }

  if (loc.port === '80') {
    return `${scheme}://${hostPart}`;
  }

  return `${scheme}://${hostPart}:${DEFAULT_API_PORT}`;
}

/** Адрес WebSocket с токеном для данного API. */
export function wsUrlFor(apiBase: string, token: string): string {
  const wsBase = apiBase.replace(/^http/, 'ws');
  return `${wsBase}/ws?token=${encodeURIComponent(token)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Преобразует ответ сервера в сессию, проверяя обязательные поля. */
export function sessionFromResponse(data: unknown): AuthSession {
  if (!isRecord(data) || typeof data.token !== 'string' || !isRecord(data.player)) {
    throw new AuthError('BAD_RESPONSE');
  }
  const p = data.player;
  if (typeof p.id !== 'number' || typeof p.login !== 'string') {
    throw new AuthError('BAD_RESPONSE');
  }
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    token: data.token,
    expiresAt: typeof data.expires_at === 'string' ? data.expires_at : '',
    player: {
      id: p.id,
      login: p.login,
      profile: typeof p.profile === 'string' ? p.profile : 'business',
      x: num(p.x, 110),
      z: num(p.z, 110),
      rotation: num(p.rotation, 0),
      balance: num(p.balance, 500),
      isAdmin: p.is_admin === true,
    },
    knownWords: Array.isArray(data.known_words)
      ? data.known_words.filter((w): w is string => typeof w === 'string')
      : [],
    inventory: Array.isArray(data.inventory)
      ? data.inventory.filter(
          (i): i is AuthItem => isRecord(i) && typeof i.item_id === 'string'
        )
      : [],
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AuthClient {
  private readonly fetchImpl: FetchLike;

  constructor(public readonly apiBase: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  public login(login: string, password: string): Promise<AuthSession> {
    return this.post('/auth/login', { login: login.trim(), password });
  }

  public register(login: string, password: string, profile: Profile): Promise<AuthSession> {
    return this.post('/auth/register', { login: login.trim(), password, profile });
  }

  /** true, если сервер и база отвечают. */
  public async health(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.apiBase}/health`, { method: 'GET' });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async post(path: string, body: Record<string, string>): Promise<AuthSession> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new AuthError('NETWORK');
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const code = isRecord(data) && typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
      throw new AuthError(code);
    }
    return sessionFromResponse(data);
  }
}

/** Хранит сессию между перезагрузками страницы. Протухшие и битые записи удаляются. */
export class SessionStore {
  public static readonly KEY = 'kitayskiy-na-sdachu.session';
  /** Сессию считаем истёкшей за минуту до срока, чтобы не открыть WebSocket с умирающим токеном. */
  public static readonly EXPIRY_MARGIN_MS = 60_000;

  constructor(private readonly storage: StorageLike | null) {}

  public load(now: number = Date.now()): AuthSession | null {
    if (!this.storage) return null;
    let raw: string | null = null;
    try {
      raw = this.storage.getItem(SessionStore.KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const session = JSON.parse(raw) as AuthSession;
      const expires = Date.parse(session.expiresAt);
      if (
        typeof session.token !== 'string' ||
        !session.player ||
        !Number.isFinite(expires) ||
        expires - SessionStore.EXPIRY_MARGIN_MS <= now
      ) {
        this.clear();
        return null;
      }
      return session;
    } catch {
      this.clear();
      return null;
    }
  }

  public save(session: AuthSession): void {
    try {
      this.storage?.setItem(SessionStore.KEY, JSON.stringify(session));
    } catch {
      // приватный режим или запрет хранилища: просто не запоминаем
    }
  }

  public clear(): void {
    try {
      this.storage?.removeItem(SessionStore.KEY);
    } catch {
      // ничего
    }
  }
}

/** localStorage, если доступен. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}
