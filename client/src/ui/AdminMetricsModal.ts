import { WSClient } from '../net/WSClient';
import { UserMetric, MetricsUpdatePayload } from '../net/types';

export class AdminMetricsModal {
  private overlay: HTMLElement;
  private tableBody: HTMLElement;
  private wsClient: WSClient | null = null;
  private isWindowOpen = false;
  private isTabFeatureEnabled = false;
  private pollInterval: any = null;
  private localFpsProvider: () => number;
  private onModalStateChange: ((isOpen: boolean) => void) | null = null;

  constructor(localFpsProvider: () => number, onModalStateChange?: (isOpen: boolean) => void) {
    this.localFpsProvider = localFpsProvider;
    this.onModalStateChange = onModalStateChange ?? null;
    this.overlay = document.createElement('div');
    this.overlay.id = 'admin-metrics-modal';
    this.overlay.className = 'admin-metrics-modal hidden';
    this.overlay.innerHTML = `
      <div class="admin-metrics-container">
        <div class="admin-metrics-header">
          <div class="admin-metrics-title">
            <span class="metrics-icon">📊</span>
            <span>СЕТЕВЫЕ МЕТРИКИ ПОЛЬЗОВАТЕЛЕЙ (TAB / B)</span>
          </div>
          <button type="button" class="admin-metrics-close" id="admin-metrics-close-btn">✕</button>
        </div>
        <div class="admin-metrics-body">
          <table class="admin-metrics-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>ЛОГИН</th>
                <th>FPS</th>
                <th>PING</th>
                <th>СТАТУС</th>
              </tr>
            </thead>
            <tbody id="admin-metrics-tbody">
              <tr><td colspan="5" style="text-align:center; padding:15px; color:#888;">Загрузка метрик...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="admin-metrics-footer">
          <span class="metrics-hint">Нажмите [TAB] / [B] или кнопку ✕ чтобы закрыть окно</span>
        </div>
      </div>
    `;

    document.body.appendChild(this.overlay);

    const closeBtn = this.overlay.querySelector('#admin-metrics-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      });
    }

    const tbody = this.overlay.querySelector('#admin-metrics-tbody');
    this.tableBody = tbody as HTMLElement;

    // Intercept TAB or B globally to toggle metrics modal
    window.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        const isTarget =
          e.key === 'Tab' ||
          e.code === 'Tab' ||
          e.key === 'b' ||
          e.key === 'B' ||
          e.key === 'и' ||
          e.key === 'И' ||
          e.code === 'KeyB';

        if (isTarget) {
          // If typing in an input/textarea, do not intercept 'b'
          const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            return;
          }

          e.preventDefault();
          e.stopPropagation();
          if (this.isTabFeatureEnabled) {
            this.toggle();
          }
        }
      },
      { capture: true }
    );
  }

  public enableTabFeature(): void {
    this.isTabFeatureEnabled = true;
  }

  public isEnabled(): boolean {
    return this.isTabFeatureEnabled;
  }

  public setWSClient(wsClient: WSClient | null): void {
    this.wsClient = wsClient;
    if (this.wsClient) {
      this.wsClient.on('METRICS_UPDATE', (payload: MetricsUpdatePayload) => {
        this.renderMetrics(payload.users);
      });
    }
  }

  public toggle(): void {
    if (this.isWindowOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  public open(): void {
    this.isWindowOpen = true;
    this.overlay.classList.remove('hidden');
    this.onModalStateChange?.(true);
    this.fetchMetrics();

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    this.pollInterval = setInterval(() => {
      if (this.isWindowOpen) {
        this.fetchMetrics();
      }
    }, 1000);
  }

  public close(): void {
    this.isWindowOpen = false;
    this.overlay.classList.add('hidden');
    this.onModalStateChange?.(false);
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  public isOpen(): boolean {
    return this.isWindowOpen;
  }

  public fetchMetrics(): void {
    if (this.wsClient && this.wsClient.isConnected) {
      this.wsClient.send('GET_METRICS', {});
    } else {
      // Offline fallback
      const localFps = this.localFpsProvider();
      this.renderMetrics([
        {
          player_id: 1,
          login: 'Вы (Локально)',
          fps: localFps,
          ping: 1,
        },
      ]);
    }
  }

  private renderMetrics(users: UserMetric[]): void {
    if (!this.tableBody) return;
    if (!users || users.length === 0) {
      this.tableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:15px; color:#888;">Нет активных пользователей</td></tr>`;
      return;
    }

    let rowsHtml = '';
    for (const u of users) {
      const fps = Math.round(u.fps);
      const ping = Math.max(0, Math.round(u.ping));

      const fpsColor = fps >= 45 ? '#00ff88' : fps >= 25 ? '#ffaa00' : '#ff3344';
      const pingColor = ping <= 50 ? '#00ff88' : ping <= 120 ? '#ffaa00' : '#ff3344';

      rowsHtml += `
        <tr>
          <td>#${u.player_id}</td>
          <td style="font-weight:600; color:#00f3ff;">${this.escapeHtml(u.login)}</td>
          <td style="color:${fpsColor}; font-weight:bold;">${fps} FPS</td>
          <td style="color:${pingColor}; font-weight:bold;">${ping} ms</td>
          <td><span class="status-dot"></span> Online</td>
        </tr>
      `;
    }

    this.tableBody.innerHTML = rowsHtml;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
