// channelProbe — 运行中 dsh 实例「真实启动通道」的只读恢复（0.1.23 设计 §5.1）。
//
// 背景（设计 §3.2 / §3.3）：0.1.21 在 external 接管路径上落 channel = null，
// 理由是「插件无法确知外部进程真实通道」。本机实测（设计 §四探针 2/3）证明该
// 前提不成立：插件既有代码早就取到了运行进程的命令行，命令行里的 npx 缓存目录
// 名又是启动 spec 的 sha512 前 16 位（npm libnpmexec 的目录名算法），因此
// 「命令行 → npx 缓存目录名 → 启动 spec」可以只读地精确恢复出真实通道。
//
// 模块纪律（设计 §5.1，QA-D23-02 / 03 / 08）：
//  - 纯 Node 层：不 import 'vscode'，可无头直测；
//  - **零 fs 依赖**：不读任何缓存目录文件（探针 4 已证伪「读 package.json 可得
//    通道」这条路径——npm 只把版本范围写回 package.json，从不写 dist-tag 规范形）；
//  - **零哈希字面量**：目录名一律运行时计算，通道集合取自 channelSelect 的
//    DSH_CHANNELS、包名取自 dshResolver 的 DSH_PKG（去硬编码纪律，DR-23-3）；
//  - 来源标注文案在本模块单点定义并导出，渲染层 import 引用、禁止就地书写
//    （与 launchInfo.ts:230/235 的 EXTERNAL_VERSION_NOTE_* 同型纪律）。
import { createHash } from 'node:crypto'

/** 通道事实的来源标注（语义分离：值与其证据强度必须一起传递）。 */
export type ChannelSource = 'cmdline' | 'registry' | 'launch-option' | null

export interface ChannelFact {
  /** 恢复出的通道名；无法恢复 → null（诚实降级，绝不猜）。 */
  channel: string | null
  /** 该值的来源；channel === null 时恒为 null（配对不变式）。 */
  source: ChannelSource
  /** 命中的 npx 缓存目录名（排障辅助，16 字符）；未命中 → 缺省。 */
  npxDirName?: string
}

/**
 * npx 缓存目录片段的匹配式：`<分隔符>_npx<分隔符><16 位十六进制><分隔符>`。
 * 前后分隔符同时接受 `\` 与 `/`（Windows 命令行实测为 `\`，正斜杠形态同型）。
 * 非全局标志：exec() 恒取首个匹配，无跨调用 lastIndex 状态。
 */
const NPX_DIR_RE = /[\\/]_npx[\\/]([0-9a-f]{16})[\\/]/

/** sha512 前 16 位十六进制串的长度（npm 目录名宽度，单一来源）。 */
const NPX_DIR_NAME_LEN = 16

/**
 * 从命令行原文提取 npx 缓存目录名；非 npx 形态 → null。
 * 只做形态提取，不做任何哈希运算——识别不出就是 null（诚实降级）。
 */
export function extractNpxDirName(cmdline: string | null): string | null {
  if (typeof cmdline !== 'string' || cmdline.length === 0) return null
  const m = NPX_DIR_RE.exec(cmdline)
  return m !== null ? m[1] : null
}

/**
 * 复刻 npm 的 npx 缓存目录名算法（设计 §四探针 3 实证，npm libnpmexec
 * lib/index.js L246-258 同型）：对「启动 spec 集合」按 `localeCompare(…, 'en')`
 * 排序后以 `\n` 连接，取 sha512 十六进制串的前 16 位。
 *
 * 本函数以单个 spec 为输入（本项目的 npx 启动形态恒为单包 spec，见
 * dshResolver 的 `${DSH_PKG}@${channel}`）。注意目录型 spec 在 npm 侧取的是
 * spec.fetchSpec（相对路径规范化），本函数不处理该形态——该形态不进入反查表，
 * 调用方判未命中即可（安全失效，不会给出错误通道）。
 */
export function npxCacheDirName(spec: string): string {
  // 逐字复刻 npm 的单元素排序 + 连接：单元素数组排序是恒等操作，join('\n')
  // 即 spec 自身；写成数组形式是为了让「与 npm 同型」这一点在源码上可见。
  const joined = [spec].sort((a, b) => a.localeCompare(b, 'en')).join('\n')
  return createHash('sha512').update(joined).digest('hex').slice(0, NPX_DIR_NAME_LEN)
}

/**
 * 由「包名前缀 + 通道集合」构造「npx 缓存目录名 → 通道」的反查表（零哈希字面量，
 * DR-23-3）。例：pkg = '@deepseek-ai/dsh'（既有 DSH_PKG），
 * channels = DSH_CHANNELS（既有通道单一来源）→
 * `{ hash(pkg + '@latest'): 'latest', hash(pkg + '@next'): 'next', hash(pkg + '@alpha'): 'alpha' }`
 *
 * 设计 §5.1 / DR-23-9（QA-D23-06）：**不收录裸包名 spec**（无 `@tag` 的 pkg）。
 * 裸 spec 的语义是「按注册表默认解析」，不等于用户选定了任何一条通道，把它映射到
 * 任何值都属编造（与「绝不猜」纪律冲突）。该形态真机可达（设计 §四探针 4：
 * 对应目录确实存在于本机缓存），因此必须显式判未命中，不能依赖「恰好不命中」。
 */
export function buildChannelSpecIndex(pkg: string, channels: readonly string[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const channel of channels) {
    index.set(npxCacheDirName(`${pkg}@${channel}`), channel)
  }
  return index
}

/**
 * 只读恢复运行实例的真实启动通道。纯函数：不读文件、不 spawn、不抛错。
 *
 * @param cmdline  运行进程命令行（调用方经既有 processCommandLine 取得，或复用
 *                 已截断的 externalCommandLine；不可得传 null）
 * @param index    buildChannelSpecIndex 的输出（注入，便于无头测试喂 mock）
 * @returns `{ channel, source, npxDirName? }`；任何一步不成立 →
 *          `{ channel: null, source: null }`（诚实降级，绝不回退配置值）
 *
 * 恢复路径（唯一主路径，设计 §5.1 / DR-23-9）：extractNpxDirName(cmdline) →
 * index 反查 → 命中即 source = 'cmdline'；未命中（版本号 spec / 本地目录 spec /
 * 裸包名 spec / 非 npx 形态 / 空命令行 / null）→ 诚实降级。
 */
export function recoverChannelFromCmdline(cmdline: string | null, index: ReadonlyMap<string, string>): ChannelFact {
  const npxDirName = extractNpxDirName(cmdline)
  if (npxDirName === null) return { channel: null, source: null }
  const channel = index.get(npxDirName)
  if (channel === undefined) return { channel: null, source: null, npxDirName }
  return { channel, source: 'cmdline', npxDirName }
}

// ---- 来源标注文案单点（设计 §5.1 / §5.7 / DR-23-10；QA-D23-08）-------------
//
// 与 launchInfo.ts:230 的 EXTERNAL_VERSION_NOTE_CMDLINE **分立不复用**：两者字面
// 相同，但语义域不同（那一条是版本证据的标注，这三条是通道证据的标注）。合用一个
// 常量会让任一侧将来改文案时连带改动另一侧，属语义耦合。

/** 通道来源标注：据启动命令行。 */
export const CHANNEL_SOURCE_NOTE_CMDLINE = '据启动命令行'
/** 通道来源标注：据实例注册表。 */
export const CHANNEL_SOURCE_NOTE_REGISTRY = '据实例注册表'
/** 通道来源标注：据启动配置。 */
export const CHANNEL_SOURCE_NOTE_LAUNCH_OPTION = '据启动配置'

/**
 * 按来源取对应的标注文案；channelSource 为 null（或未知取值）→ 空串
 * （不编造来源——值无来源时渲染层不得给标注）。渲染层唯一取值入口。
 */
export function channelSourceNote(source: ChannelSource): string {
  switch (source) {
    case 'cmdline':
      return CHANNEL_SOURCE_NOTE_CMDLINE
    case 'registry':
      return CHANNEL_SOURCE_NOTE_REGISTRY
    case 'launch-option':
      return CHANNEL_SOURCE_NOTE_LAUNCH_OPTION
    default:
      return ''
  }
}

/**
 * 运行通道无法核实时的如实文案（函数形态，buildExternalVersionNote 同型：
 * 含配置值变量）。它如实陈述两件事——运行通道不知道、配置是什么——不做任何
 * 「配置已生效」的暗示（设计 §5.3 B3 分支的理由段）。
 */
export function buildChannelUnknownNote(configChannel: string): string {
  return `（运行通道无法核实，配置为「${configChannel}」）`
}
