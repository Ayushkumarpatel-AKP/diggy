/**
 * The **trusted input adapter** seam.
 *
 * Everything the act layer does today goes through synthetic DOM events
 * (`el.click()`, dispatched `KeyboardEvent`s). Those are enough for a content
 * script and fully testable under jsdom, but some pages ignore synthetic events
 * (React controlled inputs with their own value tracker, canvas UIs, cross-origin
 * widgets). The escape hatch is `chrome.debugger`, which can inject *trusted*
 * input at the browser level (`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`)
 * so the page sees a real gesture.
 *
 * This interface is that escape hatch, defined but **not implemented** here:
 * a future `DebuggerInputAdapter` lives in the extension (it needs `chrome`),
 * not in this dependency-free package. {@link NullInputAdapter} is the safe
 * default — it reports itself unavailable, so the DOM path always runs.
 *
 * All methods are async because the eventual implementation crosses an IPC
 * boundary (`chrome.debugger.sendCommand`).
 */
export interface TrustedInputAdapter {
  /**
   * Can this adapter inject input in the current environment? When `false`, the
   * caller must fall back to synthetic DOM events. A `chrome.debugger` adapter
   * returns `false` until it has attached to the tab.
   */
  isAvailable(): boolean;

  /**
   * Move the pointer to a viewport-relative point. Separated from
   * {@link clickAt} so hover-only UIs can be driven.
   */
  moveTo(x: number, y: number): Promise<void>;

  /** Press and release the pointer at a viewport-relative point. */
  clickAt(x: number, y: number, options?: { button?: 'left' | 'right' | 'middle' }): Promise<void>;

  /**
   * Send a single key down+up. `key` uses the DOM `KeyboardEvent.key` spelling
   * (`'Enter'`, `'a'`, `'Tab'`); `text` is supplied for printable keys so the
   * character is inserted as well as the key recorded.
   */
  sendKey(key: string, options?: { text?: string }): Promise<void>;

  /** Type a string as real keystrokes into the focused element. */
  typeText(text: string): Promise<void>;

  /** Scroll the page by a viewport-relative delta. */
  scrollBy(deltaX: number, deltaY: number): Promise<void>;
}

/**
 * The do-nothing adapter. It is always **unavailable**, so callers keep using
 * the synthetic DOM path; every method resolves without touching the page.
 */
export class NullInputAdapter implements TrustedInputAdapter {
  isAvailable(): boolean {
    return false;
  }

  async moveTo(_x: number, _y: number): Promise<void> {
    /* no-op: this adapter exists only so the interface has a safe default */
  }

  async clickAt(_x: number, _y: number, _options?: { button?: 'left' | 'right' | 'middle' }): Promise<void> {
    /* no-op */
  }

  async sendKey(_key: string, _options?: { text?: string }): Promise<void> {
    /* no-op */
  }

  async typeText(_text: string): Promise<void> {
    /* no-op */
  }

  async scrollBy(_deltaX: number, _deltaY: number): Promise<void> {
    /* no-op */
  }
}
