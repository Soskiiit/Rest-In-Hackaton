/**
 * Экран входа и регистрации. Показывается до входа в мир.
 * Все тексты выводятся через textContent, без HTML из сети.
 */
import {
  AuthClient,
  AuthError,
  AuthMode,
  AuthSession,
  Profile,
  messageForError,
  validateCredentials,
} from '../net/auth';

export type AuthScreenResult = { kind: 'session'; session: AuthSession } | { kind: 'offline' };

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class AuthScreen {
  private overlay: HTMLDivElement;
  private form: HTMLFormElement;
  private loginInput: HTMLInputElement;
  private passwordInput: HTMLInputElement;
  private confirmInput: HTMLInputElement;
  private confirmRow: HTMLElement;
  private profileRow: HTMLElement;
  private errorBox: HTMLElement;
  private submitBtn: HTMLButtonElement;
  private offlineBtn: HTMLButtonElement;
  private tabLogin: HTMLButtonElement;
  private tabRegister: HTMLButtonElement;

  private mode: AuthMode = 'login';
  private busy = false;
  private resolver: ((result: AuthScreenResult) => void) | null = null;

  constructor(private readonly client: AuthClient, parent: HTMLElement = document.body) {
    this.overlay = el('div', 'auth-overlay hidden');
    this.overlay.id = 'auth-overlay';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-labelledby', 'auth-title');

    const card = el('div', 'auth-card');
    const badge = el('div', 'cyber-badge', 'ВХОД В МИР');
    const title = el('h1', 'auth-title', 'Китайский на сдачу');
    title.id = 'auth-title';
    const subtitle = el('p', 'auth-subtitle', 'Ночной рынок Шэньчжэня ждёт. Войдите, чтобы сохранить прогресс.');

    const tabs = el('div', 'auth-tabs');
    tabs.setAttribute('role', 'tablist');
    this.tabLogin = el('button', 'auth-tab', 'Вход');
    this.tabRegister = el('button', 'auth-tab', 'Регистрация');
    for (const tab of [this.tabLogin, this.tabRegister]) {
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tabs.appendChild(tab);
    }
    this.tabLogin.addEventListener('click', () => this.setMode('login'));
    this.tabRegister.addEventListener('click', () => this.setMode('register'));

    this.form = el('form', 'auth-form');
    this.form.noValidate = true;

    const loginRow = this.field('Логин', 'auth-login');
    this.loginInput = loginRow.input;
    this.loginInput.autocomplete = 'username';
    this.loginInput.maxLength = 64;
    this.loginInput.placeholder = 'от 3 до 32 символов';

    const passwordRow = this.field('Пароль', 'auth-password');
    this.passwordInput = passwordRow.input;
    this.passwordInput.type = 'password';
    this.passwordInput.placeholder = 'не меньше 8 символов';

    const confirmRow = this.field('Повторите пароль', 'auth-confirm');
    this.confirmInput = confirmRow.input;
    this.confirmInput.type = 'password';
    this.confirmInput.autocomplete = 'new-password';
    this.confirmRow = confirmRow.row;

    this.profileRow = el('fieldset', 'auth-profiles');
    const legend = el('legend', 'auth-label', 'Стартовый словарь');
    this.profileRow.appendChild(legend);
    this.profileRow.appendChild(
      this.profileOption('business', 'Бизнес', 'Цифры, цены и слова для торга', true)
    );
    this.profileRow.appendChild(
      this.profileOption('culture', 'Культура', 'Предметы, приветствия и этикет', false)
    );

    this.errorBox = el('div', 'auth-error hidden');
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.setAttribute('aria-live', 'assertive');

    this.submitBtn = el('button', 'auth-submit', 'Войти');
    this.submitBtn.type = 'submit';

    this.form.append(loginRow.row, passwordRow.row, this.confirmRow, this.profileRow, this.errorBox, this.submitBtn);
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });

    const footer = el('div', 'auth-footer');
    this.offlineBtn = el('button', 'auth-link', 'Играть без сервера (демо-режим)');
    this.offlineBtn.type = 'button';
    this.offlineBtn.addEventListener('click', () => {
      if (this.busy) return;
      this.finish({ kind: 'offline' });
    });
    const server = el('div', 'auth-server', `Сервер: ${client.apiBase}`);
    footer.append(this.offlineBtn, server);

    card.append(badge, title, subtitle, tabs, this.form, footer);
    this.overlay.appendChild(card);

    // Клавиши не должны доходить до игры, пока открыт экран входа.
    this.overlay.addEventListener('keydown', (event) => event.stopPropagation());

    parent.appendChild(this.overlay);
    this.setMode('login');
  }

  /** Показать экран. Промис разрешается после успешного входа/регистрации или выбора демо-режима. */
  public show(message?: string): Promise<AuthScreenResult> {
    this.overlay.classList.remove('hidden');
    this.setBusy(false);
    if (message) this.showError(message);
    else this.hideError();
    this.passwordInput.value = '';
    this.confirmInput.value = '';
    setTimeout(() => (this.loginInput.value ? this.passwordInput : this.loginInput).focus(), 0);
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }

  /** Показать, что идёт подключение к миру (после успешного входа). */
  public showConnecting(): void {
    this.setBusy(true, 'Подключаемся к миру…');
  }

  public hide(): void {
    this.overlay.classList.add('hidden');
    this.setBusy(false);
  }

  public isVisible(): boolean {
    return !this.overlay.classList.contains('hidden');
  }

  private finish(result: AuthScreenResult): void {
    const resolve = this.resolver;
    this.resolver = null;
    resolve?.(result);
  }

  private setMode(mode: AuthMode): void {
    this.mode = mode;
    const isRegister = mode === 'register';
    this.tabLogin.classList.toggle('active', !isRegister);
    this.tabRegister.classList.toggle('active', isRegister);
    this.tabLogin.setAttribute('aria-selected', String(!isRegister));
    this.tabRegister.setAttribute('aria-selected', String(isRegister));
    this.confirmRow.classList.toggle('hidden', !isRegister);
    this.profileRow.classList.toggle('hidden', !isRegister);
    this.passwordInput.autocomplete = isRegister ? 'new-password' : 'current-password';
    this.submitBtn.textContent = isRegister ? 'Создать аккаунт' : 'Войти';
    this.hideError();
  }

  private selectedProfile(): Profile {
    const checked = this.profileRow.querySelector<HTMLInputElement>('input[name="auth-profile"]:checked');
    return checked?.value === 'culture' ? 'culture' : 'business';
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const mode = this.mode;
    const login = this.loginInput.value;
    const password = this.passwordInput.value;
    const problem = validateCredentials(
      mode,
      login,
      password,
      mode === 'register' ? this.confirmInput.value : undefined
    );
    if (problem) {
      this.showError(problem);
      return;
    }

    this.hideError();
    this.setBusy(true, mode === 'register' ? 'Создаём аккаунт…' : 'Входим…');
    try {
      const session =
        mode === 'register'
          ? await this.client.register(login, password, this.selectedProfile())
          : await this.client.login(login, password);
      this.passwordInput.value = '';
      this.confirmInput.value = '';
      this.finish({ kind: 'session', session });
    } catch (err) {
      const code = err instanceof AuthError ? err.code : 'NETWORK';
      this.setBusy(false);
      this.showError(messageForError(code, mode));
      if (code === 'LOGIN_TAKEN') this.loginInput.focus();
      else this.passwordInput.focus();
    }
  }

  private setBusy(busy: boolean, label?: string): void {
    this.busy = busy;
    for (const control of [
      this.loginInput,
      this.passwordInput,
      this.confirmInput,
      this.submitBtn,
      this.offlineBtn,
      this.tabLogin,
      this.tabRegister,
    ]) {
      control.disabled = busy;
    }
    this.profileRow.querySelectorAll('input').forEach((input) => (input.disabled = busy));
    this.submitBtn.textContent = busy && label ? label : this.mode === 'register' ? 'Создать аккаунт' : 'Войти';
  }

  private showError(message: string): void {
    this.errorBox.textContent = message;
    this.errorBox.classList.remove('hidden');
  }

  private hideError(): void {
    this.errorBox.textContent = '';
    this.errorBox.classList.add('hidden');
  }

  private field(label: string, id: string): { row: HTMLElement; input: HTMLInputElement } {
    const row = el('div', 'auth-field');
    const caption = el('label', 'auth-label', label);
    caption.htmlFor = id;
    const input = el('input', 'auth-input');
    input.id = id;
    input.name = id;
    input.type = 'text';
    input.spellcheck = false;
    input.autocapitalize = 'off';
    row.append(caption, input);
    return { row, input };
  }

  private profileOption(value: Profile, title: string, hint: string, checked: boolean): HTMLElement {
    const option = el('label', 'auth-profile');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'auth-profile';
    radio.value = value;
    radio.checked = checked;
    const text = el('span', 'auth-profile-text');
    text.append(el('span', 'auth-profile-title', title), el('span', 'auth-profile-hint', hint));
    option.append(radio, text);
    return option;
  }
}
