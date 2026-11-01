import * as THREE from 'three';

export interface SubsystemMetric {
  timeMs: number;
  avgMs: number;
  maxMs: number;
  pct: number;
}

export interface ProfilerReport {
  fps: number;
  frameTimeMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  subsystems: Record<string, SubsystemMetric>;
  timestamp: number;
}

export class Profiler {
  private static instance: Profiler | null = null;

  public static getInstance(): Profiler {
    if (!this.instance) {
      this.instance = new Profiler();
    }
    return this.instance;
  }

  private isVisible: boolean = true;
  private containerEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;

  // Active timers
  private activeTimers: Map<string, number> = new Map();

  // Current frame measurements
  private currentFrameTimes: Map<string, number> = new Map();

  // Rolling averages (over 30 frames)
  private history: Map<string, number[]> = new Map();
  private readonly historyWindow = 30;

  // Three.js renderer metrics
  private drawCalls: number = 0;
  private triangles: number = 0;
  private geometries: number = 0;
  private textures: number = 0;
  private programs: number = 0;

  // Frame timing
  private lastFrameTimestamp: number = performance.now();
  private frameTimeMs: number = 16.6;
  private currentFps: number = 60;
  private frameCount: number = 0;
  private fpsAccumulator: number = 0;

  // Throttled UI refresh (4 times per second to avoid layout thrashing)
  private lastUiUpdate: number = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      (window as any).__profiler = this;
      (window as any).__perfReport = () => this.dumpConsoleReport();
    }
  }

  /**
   * Initializes the DOM overlay widget.
   */
  public initUI(): void {
    if (typeof document === 'undefined') return;

    let container = document.getElementById('profiler-overlay');
    if (!container) {
      container = document.createElement('div');
      container.id = 'profiler-overlay';
      container.className = 'cyber-profiler';
      container.innerHTML = `
        <div class="profiler-header">
          <span class="profiler-title">⚡ PROFILER <span class="hotkey-badge">[F3]</span></span>
          <div class="profiler-actions">
            <button id="profiler-copy-btn" class="profiler-mini-btn" title="Вывести в консоль">TABLE</button>
            <button id="profiler-toggle-btn" class="profiler-mini-btn" title="Свернуть / Развернуть">_</button>
          </div>
        </div>
        <div id="profiler-content" class="profiler-content">
          <div class="profiler-loading">Сбор метрик...</div>
        </div>
      `;
      document.body.appendChild(container);

      const toggleBtn = document.getElementById('profiler-toggle-btn');
      if (toggleBtn) {
        toggleBtn.onclick = (e) => {
          e.preventDefault();
          this.toggle();
        };
      }

      const copyBtn = document.getElementById('profiler-copy-btn');
      if (copyBtn) {
        copyBtn.onclick = (e) => {
          e.preventDefault();
          this.dumpConsoleReport();
        };
      }
    }

    this.containerEl = container;
    this.contentEl = document.getElementById('profiler-content');

    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /**
   * Toggles the profiler widget visibility.
   */
  public toggle(): void {
    this.isVisible = !this.isVisible;
    if (this.containerEl) {
      this.containerEl.style.display = this.isVisible ? 'block' : 'none';
    }
  }

  /**
   * Starts timing a specific named phase.
   * Also emits a User Timing API mark for DevTools performance flame graph.
   */
  public begin(phase: string): void {
    const now = performance.now();
    this.activeTimers.set(phase, now);

    if (typeof performance.mark === 'function') {
      try {
        performance.mark(`RIH:${phase}:start`);
      } catch {
        // Ignore in environments without marks
      }
    }
  }

  /**
   * Ends timing the phase and records duration.
   * Emits a User Timing API measure for DevTools Performance panel.
   */
  public end(phase: string): number {
    const now = performance.now();
    const start = this.activeTimers.get(phase);
    if (start === undefined) return 0;

    const duration = now - start;
    this.activeTimers.delete(phase);

    const prev = this.currentFrameTimes.get(phase) ?? 0;
    this.currentFrameTimes.set(phase, prev + duration);

    if (typeof performance.measure === 'function') {
      try {
        performance.measure(`RIH:${phase}`, `RIH:${phase}:start`);
        performance.clearMarks(`RIH:${phase}:start`);
      } catch {
        // Ignore
      }
    }

    return duration;
  }

  /**
   * Captures WebGL renderer statistics from Three.js info object.
   */
  public recordRenderInfo(renderer: THREE.WebGLRenderer): void {
    const info = renderer.info;
    this.drawCalls = info.render.calls;
    this.triangles = info.render.triangles;
    this.geometries = info.memory.geometries;
    this.textures = info.memory.textures;
    this.programs = (info.programs as any)?.length ?? 0;
  }

  /**
   * Called at the end of each frame to update rolling averages and UI.
   */
  public endFrame(delta: number): void {
    const now = performance.now();
    this.frameTimeMs = (now - this.lastFrameTimestamp);
    this.lastFrameTimestamp = now;

    this.frameCount++;
    this.fpsAccumulator += delta;
    if (this.fpsAccumulator >= 0.25) {
      this.currentFps = Math.round(this.frameCount / this.fpsAccumulator);
      this.frameCount = 0;
      this.fpsAccumulator = 0;
    }

    // Push frame times to history
    for (const [phase, time] of this.currentFrameTimes.entries()) {
      if (!this.history.has(phase)) {
        this.history.set(phase, []);
      }
      const arr = this.history.get(phase)!;
      arr.push(time);
      if (arr.length > this.historyWindow) {
        arr.shift();
      }
    }
    this.currentFrameTimes.clear();

    // Refresh UI every 250ms
    if (now - this.lastUiUpdate >= 250) {
      this.lastUiUpdate = now;
      this.updateUI();
    }
  }

  /**
   * Generates a structured snapshot report of all performance metrics.
   */
  public getReport(): ProfilerReport {
    const subsystems: Record<string, SubsystemMetric> = {};
    const totalCpuTime = Array.from(this.history.values()).reduce((sum, arr) => {
      const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      return sum + avg;
    }, 0);

    for (const [phase, arr] of this.history.entries()) {
      if (arr.length === 0) continue;
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const max = Math.max(...arr);
      const latest = arr[arr.length - 1];
      const pct = totalCpuTime > 0 ? (avg / (this.frameTimeMs || 16.6)) * 100 : 0;

      subsystems[phase] = {
        timeMs: latest,
        avgMs: avg,
        maxMs: max,
        pct,
      };
    }

    return {
      fps: this.currentFps,
      frameTimeMs: this.frameTimeMs,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      geometries: this.geometries,
      textures: this.textures,
      programs: this.programs,
      subsystems,
      timestamp: performance.now(),
    };
  }

  /**
   * Prints a formatted ASCII table of metrics to the browser console.
   */
  public dumpConsoleReport(): void {
    const report = this.getReport();
    console.group(`⚡ [Rest-In-Hackaton Profiler Report] - ${report.fps} FPS (${report.frameTimeMs.toFixed(2)} ms)`);
    console.log(`WebGL Stats: Draw Calls: ${report.drawCalls} | Tris: ${report.triangles.toLocaleString()} | Geometries: ${report.geometries} | Textures: ${report.textures} | Programs: ${report.programs}`);

    const tableData: Array<{ Subsystem: string; 'Avg (ms)': string; 'Max (ms)': string; 'Frame Budget %': string }> = [];
    for (const [name, s] of Object.entries(report.subsystems)) {
      tableData.push({
        Subsystem: name,
        'Avg (ms)': s.avgMs.toFixed(2),
        'Max (ms)': s.maxMs.toFixed(2),
        'Frame Budget %': `${s.pct.toFixed(1)}%`,
      });
    }
    console.table(tableData);
    console.groupEnd();
  }

  private updateUI(): void {
    if (!this.isVisible || !this.contentEl) return;

    const report = this.getReport();
    const fpsClass = report.fps >= 55 ? 'prof-green' : report.fps >= 30 ? 'prof-amber' : 'prof-red';

    let breakdownHtml = '';
    const sortedSubsystems = Object.entries(report.subsystems).sort((a, b) => b[1].avgMs - a[1].avgMs);

    for (const [name, s] of sortedSubsystems) {
      const barWidth = Math.min(100, Math.max(3, s.pct));
      const barColor = s.avgMs > 5 ? 'var(--neon-red)' : s.avgMs > 2 ? 'var(--neon-amber)' : 'var(--neon-cyan)';

      breakdownHtml += `
        <div class="prof-sub-row">
          <div class="prof-sub-label-wrap">
            <span class="prof-sub-name">${name}</span>
            <span class="prof-sub-time">${s.avgMs.toFixed(2)} ms</span>
          </div>
          <div class="prof-bar-track">
            <div class="prof-bar-fill" style="width: ${barWidth}%; background: ${barColor};"></div>
          </div>
        </div>
      `;
    }

    this.contentEl.innerHTML = `
      <div class="prof-metrics-grid">
        <div class="prof-metric">
          <span class="prof-m-label">FPS</span>
          <span class="prof-m-val ${fpsClass}">${report.fps}</span>
        </div>
        <div class="prof-metric">
          <span class="prof-m-label">FRAME TIME</span>
          <span class="prof-m-val">${report.frameTimeMs.toFixed(1)} ms</span>
        </div>
        <div class="prof-metric">
          <span class="prof-m-label">DRAW CALLS</span>
          <span class="prof-m-val ${report.drawCalls > 300 ? 'prof-amber' : 'prof-green'}">${report.drawCalls}</span>
        </div>
        <div class="prof-metric">
          <span class="prof-m-label">TRIANGLES</span>
          <span class="prof-m-val">${(report.triangles / 1000).toFixed(1)}k</span>
        </div>
        <div class="prof-metric">
          <span class="prof-m-label">SHADERS</span>
          <span class="prof-m-val">${report.programs}</span>
        </div>
        <div class="prof-metric">
          <span class="prof-m-label">TEXTURES</span>
          <span class="prof-m-val">${report.textures}</span>
        </div>
      </div>
      <div class="prof-breakdown-title">CPU SUBSYSTEM BREAKDOWN (AVG MS):</div>
      <div class="prof-subsystems-list">
        ${breakdownHtml || '<div class="prof-empty">Сбор метрик...</div>'}
      </div>
    `;
  }
}
