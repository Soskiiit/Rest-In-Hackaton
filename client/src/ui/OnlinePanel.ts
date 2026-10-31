import { WSClient } from '../net/WSClient';

/** Economy and local chat UI backed exclusively by server packets. */
export class OnlinePanel {
  private root = document.createElement('aside');
  private log = document.createElement('div');
  private inventory = document.createElement('div');
  private offers = document.createElement('div');
  private tradeForm = document.createElement('form');
  private amount = document.createElement('input');
  private status = document.createElement('div');
  private trade: { npc_id: string; item_id: string; trade_id: string; expires_at: string } | null = null;
  private client!: WSClient;
  private chatInput!: HTMLInputElement;
  constructor(private modal: (active: boolean) => void) {
    this.root.id = 'online-panel';
    this.root.addEventListener('click', (event) => event.stopPropagation());
    this.root.addEventListener('keydown', (event) => event.stopPropagation());
    this.root.className = 'online-panel';
    const title = document.createElement('strong'); title.textContent = 'Игроки рядом · торговля';
    const chat = document.createElement('form');
    const input = document.createElement('input');
    this.chatInput = input;
    input.placeholder = 'Чат рядом · Enter для ввода'; input.maxLength = 500; input.setAttribute('aria-label', 'Сообщение в чат');
    input.addEventListener('focus', () => this.modal(true));
    input.addEventListener('blur', (event) => { if (!this.root.contains(event.relatedTarget as Node | null)) this.modal(false); });
    const send = document.createElement('button'); send.textContent = 'Отправить';
    chat.append(input, send);
    chat.addEventListener('submit', (event) => { event.preventDefault(); if (input.value.trim()) this.client.send('CHAT', { text: input.value.trim() }); input.value = ''; input.blur(); this.modal(false); });
    this.amount.type = 'number'; this.amount.min = '1'; this.amount.max = '100000'; this.amount.step = '1'; this.amount.required = true;
    this.amount.setAttribute('aria-label', 'Сумма покупки');
    this.amount.addEventListener('focus', () => this.modal(true));
    const buy = document.createElement('button'); buy.textContent = 'Подтвердить сумму';
    this.tradeForm.append(this.amount, buy); this.tradeForm.hidden = true;
    this.tradeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!this.trade) return;
      if (Date.now() >= Date.parse(this.trade.expires_at)) { this.status.textContent = 'Предложение истекло. Откройте покупку снова.'; this.closeTrade(); return; }
      const amount = Number(this.amount.value);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return;
      this.client.send('CALCULATOR', { npc_id: this.trade.npc_id, item_id: this.trade.item_id, trade_id: this.trade.trade_id, amount });
    });
    this.root.append(title, this.log, chat, this.inventory, this.offers, this.tradeForm, this.status);
    this.root.hidden = true;
    document.body.append(this.root);
  }
  bind(client: WSClient): void {
    this.client = client; this.root.hidden = false;
    client.on('CHAT', (p) => { const row = document.createElement('div'); row.textContent = `${p.login}: ${p.text}`; this.log.append(row); while (this.log.childElementCount > 20) this.log.firstElementChild?.remove(); });
    client.on('WELCOME', (p) => { this.setInventory(p.inventory); this.offers.replaceChildren(); this.closeTrade(); });
    client.on('INVENTORY', (p) => this.setInventory(p.items));
    client.on('TRADE_OPEN', (p) => { this.trade = p; this.amount.value = String(p.price); this.tradeForm.hidden = false; this.status.textContent = `Цена ${p.price} ¥. Предложение на 30 секунд.`; this.modal(true); });
    client.on('TRADE_RESULT', (p) => { this.status.textContent = p.status === 'purchased' && p.receipt ? `Куплено: ${p.receipt.item_id}, ${p.receipt.amount} ¥` : 'Продавец отклонил сумму.'; this.closeTrade(); });
    client.on('ERROR', (p) => { this.status.textContent = p.code ?? 'Ошибка сервера'; if (p.code !== 'INSUFFICIENT_FUNDS') this.closeTrade(); });
    client.on('NPC_LEAVE', () => { this.offers.replaceChildren(); this.closeTrade(); });
    client.onConnectionChange((state) => { if (state !== 'open') { this.offers.replaceChildren(); this.closeTrade(); } });
  }
  focusChat(): void { this.modal(true); this.chatInput.focus(); }
  showOffers(npc: string, items: string[]): void {
    this.offers.replaceChildren();
    for (const id of items) {
      const button = document.createElement('button'); button.textContent = `Купить: ${id}`;
      button.addEventListener('click', () => this.client.send('TRADE_START', { npc_id: npc, item_id: id }));
      this.offers.append(button);
    }
  }
  hide(): void { this.root.hidden = true; this.closeTrade(); }
  private closeTrade(): void { const hadTrade = this.trade !== null; this.trade = null; this.tradeForm.hidden = true; if (hadTrade) this.modal(false); }
  private setInventory(items: Array<{ item_id: string }>): void { this.inventory.textContent = `Инвентарь: ${(items ?? []).map((i) => i.item_id).join(', ') || 'пусто'}`; }
}
