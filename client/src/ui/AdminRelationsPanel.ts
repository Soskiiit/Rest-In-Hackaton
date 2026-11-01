/**
 * AdminRelationsPanel: admin menu opened with [Q] while aiming at an NPC.
 * Lists every registered player with the NPC's attitude to them (respect / aggression) and lets the admin
 * set new values for one player. The server stores them as an offset from the NPC's shared mood.
 */

import type { AdminAttitude, AdminNpcRelationsPayload } from '../net/types';

export const NPC_DISPLAY_NAMES: Record<string, string> = {
  lao_wang: 'Лао Ван (老王)',
  chef_chen: 'Повар Чэнь',
  guard_zhang: 'Охранник Чжан',
};

export interface AdminRow {
  playerId: number;
  login: string;
  online: boolean;
  mianzi: number;
  aggro: number;
  /** Signed difference from the shared mood, e.g. "+40" / "−15"; empty when there is no personal offset. */
  note: string;
}

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

/** View model for the table: online players first, then by login. */
export function toAdminRows(players: AdminAttitude[] = []): AdminRow[] {
  return [...players]
    .sort((a, b) => Number(b.online) - Number(a.online) || a.login.localeCompare(b.login))
    .map((p) => ({
      playerId: p.player_id,
      login: p.login,
      online: p.online,
      mianzi: p.mianzi,
      aggro: p.aggro,
      note:
        p.mianzi_offset || p.aggro_offset
          ? `личное: уважение ${signed(p.mianzi_offset)}, агрессия ${signed(p.aggro_offset)}`
          : '',
    }));
}

export interface AdminRelationsPanelCallbacks {
  onSave: (npcId: string, playerId: number, mianzi: number, aggro: number) => void;
  onClose: () => void;
}

export class AdminRelationsPanel {
  private readonly doc: Document;
  private readonly callbacks: AdminRelationsPanelCallbacks;
  private overlay: HTMLElement | null = null;
  private npcId = '';
  private selectedId: number | null = null;
  private rows: AdminRow[] = [];
  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
    }
  };

  constructor(callbacks: AdminRelationsPanelCallbacks, doc: Document = document) {
    this.callbacks = callbacks;
    this.doc = doc;
  }

  public isOpen(): boolean {
    return this.overlay !== null;
  }

  public getNpcId(): string {
    return this.npcId;
  }

  /** Opens the panel, or refreshes it in place (keeping the selected player) when the server sends an update. */
  public show(payload: AdminNpcRelationsPayload): void {
    if (this.npcId !== payload.npc_id) this.selectedId = null;
    this.npcId = payload.npc_id;
    this.rows = toAdminRows(payload.players);
    if (!this.overlay) {
      this.overlay = this.doc.createElement('div');
      this.overlay.className = 'admin-overlay';
      this.overlay.addEventListener('click', (e) => {
        if (e.target === this.overlay) this.close();
      });
      this.doc.body.appendChild(this.overlay);
      this.doc.addEventListener('keydown', this.onKeyDown);
    }
    this.render(payload);
  }

  public close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.doc.removeEventListener('keydown', this.onKeyDown);
    this.callbacks.onClose();
  }

  private el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  private render(payload: AdminNpcRelationsPayload): void {
    const overlay = this.overlay!;
    overlay.replaceChildren();
    const card = this.el('div', 'admin-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Отношение продавца к игрокам');

    const header = this.el('div', 'admin-header');
    header.append(
      this.el('span', 'admin-badge', 'АДМИН'),
      this.el('span', 'admin-title', `${NPC_DISPLAY_NAMES[this.npcId] ?? this.npcId}: отношение к игрокам`)
    );
    const closeBtn = this.el('button', 'admin-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Закрыть');
    closeBtn.addEventListener('click', () => this.close());
    header.append(closeBtn);
    card.append(header);

    if (payload.shared) {
      card.append(
        this.el(
          'div',
          'admin-shared',
          `Общее настроение: уважение ${payload.shared.mianzi} · агрессия ${payload.shared.aggro} · ${payload.shared.state}`
        )
      );
    }

    const table = this.el('table', 'admin-table');
    const head = this.el('tr');
    head.append(this.el('th', '', 'Игрок'), this.el('th', '', 'Уважение'), this.el('th', '', 'Агрессия'));
    const thead = this.el('thead');
    thead.append(head);
    const tbody = this.el('tbody');
    for (const row of this.rows) {
      const tr = this.el('tr', 'admin-row' + (row.playerId === this.selectedId ? ' selected' : ''));
      tr.dataset.playerId = String(row.playerId);
      tr.tabIndex = 0;
      const who = this.el('td', 'admin-player');
      who.append(this.el('span', 'admin-online' + (row.online ? ' on' : ''), '●'), this.el('span', 'admin-login', row.login));
      if (row.note) who.append(this.el('div', 'admin-note', row.note));
      tr.append(who, this.meterCell(row.mianzi, 'mianzi'), this.meterCell(row.aggro, 'aggro'));
      const select = () => {
        this.selectedId = row.playerId;
        this.render(payload);
      };
      tr.addEventListener('click', select);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    card.append(table);
    if (this.rows.length === 0) card.append(this.el('div', 'admin-empty', 'Нет зарегистрированных игроков'));

    const selected = this.rows.find((r) => r.playerId === this.selectedId);
    if (selected) card.append(this.editor(selected));
    else card.append(this.el('div', 'admin-hint', 'Выберите игрока, чтобы изменить отношение продавца к нему.'));

    card.append(this.el('div', 'admin-footer', 'Esc / Q — закрыть'));
    overlay.append(card);
  }

  private meterCell(value: number, kind: 'mianzi' | 'aggro'): HTMLTableCellElement {
    const td = this.el('td', 'admin-meter-cell');
    const meter = this.el('div', `admin-meter ${kind}`);
    const fill = this.el('div', 'admin-meter-fill');
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    meter.append(fill);
    td.append(meter, this.el('span', 'admin-meter-value', String(value)));
    return td;
  }

  private editor(row: AdminRow): HTMLElement {
    const box = this.el('div', 'admin-editor');
    box.append(this.el('div', 'admin-editor-title', `Отношение к игроку ${row.login}`));
    const slider = (label: string, kind: string, value: number) => {
      const wrap = this.el('label', `admin-slider ${kind}`);
      const input = this.el('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.value = String(value);
      input.name = kind;
      const out = this.el('output', 'admin-slider-value', String(value));
      input.addEventListener('input', () => {
        out.textContent = input.value;
      });
      wrap.append(this.el('span', 'admin-slider-label', label), input, out);
      box.append(wrap);
      return input;
    };
    const mianzi = slider('Уважение', 'mianzi', row.mianzi);
    const aggro = slider('Агрессия', 'aggro', row.aggro);
    const save = this.el('button', 'admin-save', 'Сохранить');
    save.type = 'button';
    save.addEventListener('click', () => {
      this.callbacks.onSave(this.npcId, row.playerId, Number(mianzi.value), Number(aggro.value));
    });
    box.append(
      save,
      this.el('div', 'admin-hint', 'Продавец будет вести себя с игроком по этим значениям; дальше они меняются вместе с общим настроением.')
    );
    return box;
  }
}
