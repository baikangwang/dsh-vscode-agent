// panelMessages — panel-message routing + the state×button disable matrix
// (0.1.15 #91; design §5.6). PURE NODE (no 'vscode' import) so the routing and
// the matrix are headlessly testable (QA C2 layering; E-SIM-2 precedent).
//
// Two layers, one source:
//  - script side (UX layer): the panel HTML bakes `buttonDisableRules` output
//    per state (webviewHtml.ts) so buttons carry `disabled` before any click;
//  - extension side (correctness layer): webview.ts re-computes the SAME rules
//    on every message and drops actions the current state does not allow —
//    the script-side disable is UX sugar, never the security/correctness gate.
//
// Whitelist invariant (PP-11-4): PANEL_MESSAGE_TYPES ≡ the uplink `type` set
// actually emitted by the panel page script in webviewHtml.ts (webviewReady /
// stateAck / showDetails / openBrowser / restart / stop / chooseChannel).
// Unknown types are a logged no-op (PP-11-3), never a throw.
//
// `chooseChannel` carries the channel enum string; `null` is the 「稍后再说」
// (postpone) sentinel — the design §5.1 Esc semantics: start with the CURRENT
// channel, do NOT set channelSelected (asked again next launch).

/** Uplink message types the panel page script may send (whitelist, single source). */
export type PanelMessageType =
  | 'webviewReady'
  | 'stateAck'
  | 'showDetails'
  | 'openBrowser'
  | 'restart'
  | 'stop'
  | 'chooseChannel'

export const PANEL_MESSAGE_TYPES: readonly PanelMessageType[] = [
  'webviewReady',
  'stateAck',
  'showDetails',
  'openBrowser',
  'restart',
  'stop',
  'chooseChannel',
]

/** The four toolbar buttons the disable matrix gates (design §5.6). */
export type PanelButtonId = 'details' | 'openBrowser' | 'restart' | 'stop'

/**
 * UX-layer disable matrix, keyed by RuntimeState (design §5.6; true = disabled):
 *  awaitingChannel : only ⓘ (nothing to open/stop/restart yet);
 *  starting        : ■ stays live = CANCEL the launch (stopRequested guard);
 *  ready           : all live;
 *  error           : ⟳/■ live (restart guidance + cleanup), ↗ dead;
 *  stopped         : only ⟳ (reconnect) besides ⓘ;
 *  anything else   : conservatively all disabled (defensive default).
 */
export function buttonDisableRules(state: string): Record<PanelButtonId, boolean> {
  switch (state) {
    case 'awaitingChannel':
      return { details: false, openBrowser: true, restart: true, stop: true }
    case 'starting':
      return { details: false, openBrowser: true, restart: true, stop: false }
    case 'ready':
      return { details: false, openBrowser: false, restart: false, stop: false }
    case 'error':
      return { details: false, openBrowser: true, restart: false, stop: false }
    case 'stopped':
      return { details: false, openBrowser: true, restart: false, stop: true }
    default:
      // idle / unknown state: no semantics to trust — disable everything.
      return { details: true, openBrowser: true, restart: true, stop: true }
  }
}

/**
 * Sink bag consumed by routePanelMessage. All optional so headless tests can
 * spy on exactly the types under assertion; webview.ts wires the full set.
 */
export interface PanelMessageSinks {
  webviewReady?(): void
  /** `appliedState` is the state the page rendered (string per postMessage). */
  stateAck?(appliedState?: string): void
  showDetails?(): void
  openBrowser?(): void
  restart?(): void
  stop?(): void
  /**
   * `channel` = the picked enum value, or null for the 「稍后再说」 postpone
   * sentinel. A non-enum string is passed through — the extension side
   * normalizes it (ADR-29-②: invalid → 'latest' + rlog).
   */
  chooseChannel?(channel: string | null): void
  /** Unknown-type defense surface: invoked exactly once per unknown message. */
  unknownType?(type: string): void
}

/**
 * Route one raw postMessage payload to its sink. Returns true when the type
 * was whitelisted (sink invoked), false for an unknown/shapeless message
 * (unknownType sink invoked for the log trace; never throws).
 */
export function routePanelMessage(msg: unknown, sinks: PanelMessageSinks): boolean {
  if (msg === null || typeof msg !== 'object') return false
  const type = (msg as { type?: unknown }).type
  if (typeof type !== 'string') return false
  const m = msg as Record<string, unknown>
  switch (type) {
    case 'webviewReady':
      sinks.webviewReady?.()
      return true
    case 'stateAck':
      sinks.stateAck?.(typeof m.appliedState === 'string' ? m.appliedState : undefined)
      return true
    case 'showDetails':
      sinks.showDetails?.()
      return true
    case 'openBrowser':
      sinks.openBrowser?.()
      return true
    case 'restart':
      sinks.restart?.()
      return true
    case 'stop':
      sinks.stop?.()
      return true
    case 'chooseChannel': {
      const ch = m.channel
      sinks.chooseChannel?.(typeof ch === 'string' ? ch : null)
      return true
    }
    default:
      sinks.unknownType?.(type)
      return false
  }
}
