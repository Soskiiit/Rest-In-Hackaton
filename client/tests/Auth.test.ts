import { describe, it, expect, vi } from 'vitest';
import {
  AuthClient,
  AuthError,
  SessionStore,
  StorageLike,
  messageForError,
  resolveApiBase,
  sessionFromResponse,
  validateCredentials,
  wsUrlFor,
} from '../src/net/auth';

const serverReply = {
  token: 'jwt.token.value',
  expires_at: '2030-01-01T00:00:00Z',
  player: { id: 7, login: 'alice', profile: 'culture', x: 110, z: 110, rotation: 0, balance: 500 },
  known_words: ['word_jade', 'word_tea'],
  inventory: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

describe('validateCredentials (правила сервера)', () => {
  it('принимает корректные данные', () => {
    expect(validateCredentials('login', 'alice', 'password1')).toBeNull();
    expect(validateCredentials('register', '  bob  ', 'password1', 'password1')).toBeNull();
  });

  it('проверяет длину логина после trim', () => {
    expect(validateCredentials('login', '  ab  ', 'password1')).toMatch(/от 3 до 32/);
    expect(validateCredentials('login', 'x'.repeat(33), 'password1')).toMatch(/от 3 до 32/);
    expect(validateCredentials('login', 'Лао', 'password1')).toBeNull(); // 3 символа, 6 байт
  });

  it('считает длину пароля в байтах, как bcrypt на сервере', () => {
    expect(validateCredentials('login', 'alice', 'short')).toMatch(/не меньше 8/);
    expect(validateCredentials('login', 'alice', 'я'.repeat(37))).toMatch(/максимум 72/); // 74 байта
    expect(validateCredentials('login', 'alice', 'я'.repeat(36))).toBeNull(); // 72 байта
  });

  it('при регистрации требует совпадения паролей', () => {
    expect(validateCredentials('register', 'alice', 'password1', 'password2')).toMatch(/не совпадают/);
  });
});

describe('адреса сервера', () => {
  it('берёт хост страницы и порт 3000', () => {
    expect(resolveApiBase({ protocol: 'http:', hostname: '192.168.1.10', search: '' })).toBe(
      'http://192.168.1.10:3000'
    );
  });

  it('учитывает ?api_port и ?ws_port', () => {
    expect(resolveApiBase({ protocol: 'http:', hostname: 'localhost', search: '?api_port=4000' })).toBe(
      'http://localhost:4000'
    );
    expect(resolveApiBase({ protocol: 'http:', hostname: 'localhost', search: '?ws_port=4001' })).toBe(
      'http://localhost:4001'
    );
  });

  it('строит WebSocket-адрес с экранированным токеном', () => {
    expect(wsUrlFor('http://10.0.0.5:3000', 'a.b/c+d')).toBe('ws://10.0.0.5:3000/ws?token=a.b%2Fc%2Bd');
    expect(wsUrlFor('https://host:3000', 't')).toBe('wss://host:3000/ws?token=t');
  });
});

describe('AuthClient', () => {
  it('регистрирует игрока и возвращает сессию', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, serverReply));
    const client = new AuthClient('http://h:3000', fetchMock);
    const session = await client.register(' alice ', 'password1', 'culture');

    expect(fetchMock).toHaveBeenCalledWith('http://h:3000/auth/register', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ login: 'alice', password: 'password1', profile: 'culture' });
    expect(session.token).toBe('jwt.token.value');
    expect(session.player.login).toBe('alice');
    expect(session.knownWords).toEqual(['word_jade', 'word_tea']);
  });

  it('входит без поля profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, serverReply));
    await new AuthClient('http://h:3000', fetchMock).login('alice', 'password1');
    expect(fetchMock.mock.calls[0][0]).toBe('http://h:3000/auth/login');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ login: 'alice', password: 'password1' });
  });

  it('передаёт код ошибки сервера', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(409, { error: 'LOGIN_TAKEN' }));
    await expect(new AuthClient('http://h:3000', fetchMock).register('alice', 'password1', 'business'))
      .rejects.toMatchObject({ code: 'LOGIN_TAKEN' });
  });

  it('сетевой сбой превращает в NETWORK', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await new AuthClient('http://h:3000', fetchMock).login('alice', 'password1').catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.code).toBe('NETWORK');
  });

  it('ответ без токена считает ошибкой формата', () => {
    expect(() => sessionFromResponse({ player: {} })).toThrow(AuthError);
  });

  it('health() не бросает исключений', async () => {
    const down = new AuthClient('http://h:3000', vi.fn().mockRejectedValue(new Error('down')));
    expect(await down.health()).toBe(false);
    const up = new AuthClient('http://h:3000', vi.fn().mockResolvedValue(jsonResponse(200, { status: 'ok' })));
    expect(await up.health()).toBe(true);
  });
});

describe('messageForError', () => {
  it('различает неверный пароль и неверную длину полей', () => {
    expect(messageForError('INVALID_CREDENTIALS', 'login')).toMatch(/Неверный логин или пароль/);
    expect(messageForError('INVALID_CREDENTIALS', 'register')).toMatch(/от 3 до 32/);
  });

  it('объясняет занятый логин и неизвестные коды', () => {
    expect(messageForError('LOGIN_TAKEN', 'register')).toMatch(/занят/);
    expect(messageForError('HTTP_502', 'login')).toMatch(/HTTP_502/);
  });
});

describe('SessionStore', () => {
  const session = sessionFromResponse(serverReply);

  it('сохраняет и восстанавливает сессию', () => {
    const store = new SessionStore(new MemoryStorage());
    store.save(session);
    expect(store.load(Date.parse('2029-12-31T00:00:00Z'))?.player.login).toBe('alice');
  });

  it('удаляет истёкшую сессию (с запасом в минуту)', () => {
    const storage = new MemoryStorage();
    const store = new SessionStore(storage);
    store.save(session);
    expect(store.load(Date.parse('2029-12-31T23:59:30Z'))).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('удаляет испорченную запись', () => {
    const storage = new MemoryStorage();
    storage.setItem(SessionStore.KEY, '{not json');
    expect(new SessionStore(storage).load()).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('работает без хранилища', () => {
    const store = new SessionStore(null);
    store.save(session);
    expect(store.load()).toBeNull();
  });
});
