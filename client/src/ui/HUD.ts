/**
 * HUD: Heads-Up Display diagnostics overlay.
 * Renders FPS, cache percentage (guaranteeing <= 10% memory limit),
 * loaded chunks count, player coordinates, balance, and network status.
 */

export class HUD {
  private fpsEl: HTMLElement | null;
  private cacheEl: HTMLElement | null;
  private cacheBadgeEl: HTMLElement | null;
  private chunksEl: HTMLElement | null;
  private coordsEl: HTMLElement | null;
  private balanceEl: HTMLElement | null;
  private statusEl: HTMLElement | null;
  private toastContainerEl: HTMLElement | null;

  private currentBalance: number = 500;

  constructor() {
    this.fpsEl = document.getElementById('hud-fps');
    this.cacheEl = document.getElementById('hud-cache');
    this.cacheBadgeEl = document.getElementById('hud-cache-badge');
    this.chunksEl = document.getElementById('hud-chunks');
    this.coordsEl = document.getElementById('hud-coords');
    this.balanceEl = document.getElementById('hud-balance');
    this.statusEl = document.getElementById('hud-status');
    this.toastContainerEl = document.getElementById('toast-container');
  }

  /**
   * Updates network status pill in HUD.
   */
  public setWsStatus(status: 'connected' | 'mock' | 'disconnected'): void {
    if (!this.statusEl) return;

    this.statusEl.className = 'status-pill';
    if (status === 'connected') {
      this.statusEl.classList.add('status-connected');
      this.statusEl.textContent = 'WS: ONLINE';
    } else if (status === 'mock') {
      this.statusEl.classList.add('status-mock');
      this.statusEl.textContent = 'WS: MOCK DEMO';
    } else {
      this.statusEl.classList.add('status-disconnected');
      this.statusEl.textContent = 'WS: OFFLINE';
    }
  }

  /**
   * Updates balance display independently on network BALANCE packets.
   */
  public updateBalance(balance: number): void {
    this.currentBalance = balance;
    if (this.balanceEl) {
      this.balanceEl.textContent = `${balance} ¥`;
    }
  }

  /**
   * Updates per-frame real-time telemetry (FPS, cache %, chunks, coordinates, balance).
   * Visual badge strictly displays 'ЛИМИТ 10% OK' in green when cachePercent <= 10%,
   * and 'ПРЕВЫШЕН ЛИМИТ!' in red alert if cachePercent > 10%.
   */
  public update(
    fps: number,
    cachePercent: number,
    chunkCount: number,
    x: number,
    z: number,
    balance?: number
  ): void {
    if (this.fpsEl) {
      this.fpsEl.textContent = `${Math.round(fps)}`;
    }

    if (this.cacheEl) {
      const formattedPercent = Number.isInteger(cachePercent)
        ? `${cachePercent}%`
        : `${cachePercent.toFixed(1)}%`;
      this.cacheEl.textContent = formattedPercent;
    }

    if (this.cacheBadgeEl) {
      if (cachePercent <= 10) {
        this.cacheBadgeEl.className = 'badge-ok';
        this.cacheBadgeEl.setAttribute('data-status', 'ok');
        this.cacheBadgeEl.textContent = 'ЛИМИТ 10% OK';
      } else {
        this.cacheBadgeEl.className = 'badge-warn';
        this.cacheBadgeEl.setAttribute('data-status', 'warn');
        this.cacheBadgeEl.textContent = 'ПРЕВЫШЕН ЛИМИТ!';
      }
    }

    if (this.chunksEl) {
      this.chunksEl.textContent = `${chunkCount} / 100`;
    }

    if (this.coordsEl) {
      this.coordsEl.textContent = `(${x.toFixed(1)}, ${z.toFixed(1)})`;
    }

    if (balance !== undefined) {
      this.currentBalance = balance;
    }
    if (this.balanceEl) {
      this.balanceEl.textContent = `${this.currentBalance} ¥`;
    }
  }

  /**
   * Shows a transient toast notification on screen.
   */
  public showToast(message: string, durationMs: number = 3000): void {
    if (!this.toastContainerEl) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    this.toastContainerEl.appendChild(toast);

    setTimeout(() => {
      if (toast.parentElement) {
        toast.parentElement.removeChild(toast);
      }
    }, durationMs);
  }

  // Diagnostic / Headless Test Getters
  public getFpsText(): string { return this.fpsEl?.textContent ?? ''; }
  public getCacheText(): string { return this.cacheEl?.textContent ?? ''; }
  public getCacheBadgeText(): string { return this.cacheBadgeEl?.textContent ?? ''; }
  public getCacheBadgeClass(): string { return this.cacheBadgeEl?.className ?? ''; }
  public isLimitOk(): boolean { return this.cacheBadgeEl?.classList.contains('badge-ok') ?? false; }
  public getChunksText(): string { return this.chunksEl?.textContent ?? ''; }
  public getCoordsText(): string { return this.coordsEl?.textContent ?? ''; }
  public getBalanceText(): string { return this.balanceEl?.textContent ?? ''; }
}
