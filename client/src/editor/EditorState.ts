/**
 * EditorState: Operating mode state machine and event emitter for Rest-In-Hackaton.
 * Decouples gameplay controllers from editor tooling without circular dependencies.
 */

export enum AppMode {
  GAME = 'GAME',
  EDITOR = 'EDITOR',
}

export interface IEditorModeListener {
  onModeChanged(mode: AppMode, prevMode?: AppMode): void;
}

export type EditorModeChangeCallback = (mode: AppMode, prevMode?: AppMode) => void;

export class EditorStateManager {
  private currentMode: AppMode;
  private readonly listeners: Set<IEditorModeListener | EditorModeChangeCallback> = new Set();
  private isTransitioning: boolean = false;

  constructor(initialMode: AppMode = AppMode.GAME) {
    this.currentMode = initialMode;
  }

  /**
   * Returns current active mode.
   */
  public getMode(): AppMode {
    return this.currentMode;
  }

  /**
   * Convenience check for EDITOR mode.
   */
  public isEditor(): boolean {
    return this.currentMode === AppMode.EDITOR;
  }

  public isEditorMode(): boolean {
    return this.isEditor();
  }

  /**
   * Convenience check for GAME mode.
   */
  public isGame(): boolean {
    return this.currentMode === AppMode.GAME;
  }

  public isGameMode(): boolean {
    return this.isGame();
  }

  /**
   * Sets active application mode.
   * Returns true if transition occurred, false if targetMode was already active or transition was rejected.
   */
  public setMode(targetMode: AppMode): boolean {
    if (this.currentMode === targetMode) {
      return false; // Idempotent no-op
    }

    if (this.isTransitioning) {
      console.warn(`[EditorState] Mode change to ${targetMode} rejected: transition already in progress.`);
      return false;
    }

    const prevMode = this.currentMode;
    this.isTransitioning = true;
    this.currentMode = targetMode;

    try {
      this.listeners.forEach((listener) => {
        try {
          if (typeof listener === 'function') {
            listener(targetMode, prevMode);
          } else if (listener && typeof listener.onModeChanged === 'function') {
            listener.onModeChanged(targetMode, prevMode);
          }
        } catch (err) {
          console.error('[EditorState] Exception in mode change listener:', err);
        }
      });
      return true;
    } finally {
      this.isTransitioning = false;
    }
  }

  /**
   * Toggles between GAME and EDITOR modes.
   */
  public toggleMode(): AppMode {
    const nextMode = this.currentMode === AppMode.GAME ? AppMode.EDITOR : AppMode.GAME;
    this.setMode(nextMode);
    return this.currentMode;
  }

  /**
   * Subscribes to mode change events. Returns an unsubscribe function.
   */
  public addListener(listener: IEditorModeListener | EditorModeChangeCallback): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Removes a subscribed listener.
   */
  public removeListener(listener: IEditorModeListener | EditorModeChangeCallback): void {
    this.listeners.delete(listener);
  }

  /**
   * Removes all subscribed listeners (used on cleanup/test reset).
   */
  public clearListeners(): void {
    this.listeners.clear();
  }
}
