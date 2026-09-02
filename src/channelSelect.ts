// channelSelect — dsh release-channel model + first-launch selection flow
// (0.1.14, ADR-29; design §2). PURE NODE (no 'vscode' import) so sim tests the
// whole flow headlessly with mock deps (E-SIM-1: the vscode layer cannot be
// required headlessly; E-SIM-2: pure-module + deps-injection precedent).
//
// Channel model (E-CH): `latest` / `next` (rc stability line) / `alpha`
// (experimental, carries the browser-auth token contract). The pre-0.1.14
// enum value `preview` is NOT a published npm dist-tag (npm view → E404) —
// legacy values normalize to `latest` at the two read points (extension
// readConfig + the dshResolver entry guard; never written back — the user can
// still see/fix the raw value in settings, ADR-29-②).
//
// First-launch flow (ADR-29-③④⑤): `dsh.channelSelected === false` → present a
// native QuickPick (via the injected `pick` dep) BEFORE any runtime
// construction — 「先选后启」 hard ordering. Picking writes
// `dsh.channel` + `dsh.channelSelected=true` BEFORE this function resolves
// (the write happens first; the caller then builds the runtime — PU-9-2
// asserts the call order headlessly). Esc/cancel keeps the current value and
// does NOT set the flag (explicit give-up ≠ chosen; asked again next start).
// A config-write failure keeps the previous value and continues startup
// (honest degradation — worst case equals the 0.1.13 behavior, §2.3-④).

export type DshChannel = 'latest' | 'next' | 'alpha'

/** The published dist-tag set (single source; package.json enum mirrors it). */
export const DSH_CHANNELS: readonly DshChannel[] = ['latest', 'next', 'alpha']

export function isDshChannel(v: string): v is DshChannel {
  return v === 'latest' || v === 'next' || v === 'alpha'
}

/**
 * Channel normalization (PU-9-1 direct test object): a valid channel passes
 * through untouched; the legacy `preview` (E404 dist-tag) and ANY other
 * invalid value map to `latest` with `normalized: true` (never throws).
 */
export function normalizeChannel(raw: string): { channel: DshChannel; normalized: boolean } {
  if (isDshChannel(raw)) return { channel: raw, normalized: false }
  return { channel: 'latest', normalized: true }
}

/** The ADR-29 rlog anchor for legacy/invalid normalization (single point). */
export function normalizeChannelLogLine(raw: string, channel: DshChannel): string {
  return `channel '${raw}' is not a published dist-tag; normalizing to '${channel}' (ADR-29)`
}

/** QuickPick item shape the injected `pick` dep consumes. */
export interface ChannelPickItem {
  label: string
  detail?: string
}

/**
 * The three pick items (design §2.3-② copy, verbatim semantics; NO version
 * literals — runtime-unknowable, de-hardcode discipline; versions are shown by
 * the existing ADR-22 details card).
 */
export function channelPickItems(): ChannelPickItem[] {
  return [
    { label: 'latest', detail: '稳定通道（rc 版本）——经典启动契约，面板直连可用' },
    { label: 'next', detail: '预发布前瞻——当前与 latest 相同，上游发布新 rc 时先于 latest' },
    {
      label: 'alpha',
      detail: '最新实验通道——含 browser-auth 新特性，启动后带访问 token、面板经本地代理接入；首次冷拉取可能需数分钟',
    },
  ]
}

/**
 * The QuickPick placeholder (design §2.3-③; single point so extension.ts and
 * any future consumer share the exact copy).
 */
export const CHANNEL_PICK_PLACEHOLDER = '选择要启动的 dsh 通道（可稍后在设置或命令面板中更改）'

/** Dependency injection: the vscode surface shrinks to these 6 methods. */
export interface ChannelSelectDeps {
  /** showQuickPick shape: resolves the picked label, or undefined on Esc. */
  pick(items: ChannelPickItem[]): Promise<string | undefined>
  /** Config store: `dsh.channel` read/write (global scope at the consumer). */
  readChannel(): string
  writeChannel(v: string): PromiseLike<void>
  /** Config store: `dsh.channelSelected` read/write (first-launch flag). */
  readChannelSelected(): boolean
  writeChannelSelected(v: boolean): PromiseLike<void>
  /** rlog seam. */
  log(msg: string): void
}

export interface ChannelSelectResult {
  /** The channel the caller should run with (current value when not selected). */
  channel: string
  /** True when the user picked a channel and the writes SUCCEEDED. */
  selected: boolean
  /** True when the user cancelled (Esc) — flag NOT set, asked again next time. */
  cancelled: boolean
  /** True when a config write threw — previous value kept, startup continues. */
  writeFailed: boolean
}

/**
 * First-launch channel selection (§2.4 module contract):
 *  1. first-launch gate — `readChannelSelected() === false` proceeds (a
 *     `forcePick` opt bypasses the gate for the `dsh.chooseChannel` re-entry);
 *  2. normalize the current raw value (legacy `preview` → `latest`) and rlog;
 *  3. present the three items; on a valid pick write channel + selected flag
 *     IN ORDER, awaited, BEFORE resolving (「先选后启」 ordering is observable
 *     via mock deps call order, PU-9-2);
 *  4. Esc → keep the current value, do NOT set the flag, `cancelled: true`;
 *  5. write failure → keep the previous value, `writeFailed: true`, rlog,
 *     startup continues (selection failure never blocks startup).
 */
export async function runFirstLaunchChannelSelect(
  deps: ChannelSelectDeps,
  opts?: { forcePick?: boolean },
): Promise<ChannelSelectResult> {
  const raw = deps.readChannel()
  const norm = normalizeChannel(raw)
  if (norm.normalized) deps.log(normalizeChannelLogLine(raw, norm.channel))
  if (opts?.forcePick !== true && deps.readChannelSelected() === true) {
    return { channel: norm.channel, selected: false, cancelled: false, writeFailed: false }
  }
  const picked = await deps.pick(channelPickItems())
  if (typeof picked !== 'string' || !isDshChannel(picked)) {
    deps.log(
      `channel select: cancelled by user (no pick); keeping '${norm.channel}' and NOT marking channelSelected (asked again next launch)`,
    )
    return { channel: norm.channel, selected: false, cancelled: true, writeFailed: false }
  }
  try {
    await deps.writeChannel(picked)
    await deps.writeChannelSelected(true)
  } catch (err) {
    deps.log(`channel select: config write failed (${(err as Error).message}); keeping '${norm.channel}' and continuing startup (honest degradation)`)
    return { channel: norm.channel, selected: false, cancelled: false, writeFailed: true }
  }
  deps.log(`channel select: user picked '${picked}'; channel + channelSelected written before runtime start (先选后启)`)
  return { channel: picked, selected: true, cancelled: false, writeFailed: false }
}
