// Paths for the DSH runtime registry, startup lock and logs.
// Pure Node (no vscode dependency) so it can be exercised headlessly.
import * as os from 'node:os'
import * as path from 'node:path'

/** Application data dir for this extension's coordination artifacts. */
export function dataDir(): string {
  // Overridable for headless tests; Windows default: %LOCALAPPDATA%\DshVscode
  if (process.env.DSH_VSCODE_DATA_DIR) return process.env.DSH_VSCODE_DATA_DIR
  const local = process.env.LOCALAPPDATA
  const base = local && local.length > 0 ? local : os.tmpdir()
  return path.join(base, 'DshVscode')
}

export function instanceFile(): string {
  return path.join(dataDir(), 'instance.json')
}

export function startupLockFile(): string {
  return path.join(dataDir(), 'startup.lock')
}

export function logFile(): string {
  return path.join(dataDir(), 'logs', 'dsh.log')
}

export function ensureDataDir(): void {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs')
  mkdirSync(dataDir(), { recursive: true })
  const logs = path.join(dataDir(), 'logs')
  mkdirSync(logs, { recursive: true })
}
