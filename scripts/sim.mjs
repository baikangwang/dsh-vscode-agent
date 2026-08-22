// Headless verification of the application-level lifecycle arbitration:
//  - first window acquires the startup lock, second window cannot
//  - closing a non-last window keeps dsh alive
//  - closing the last window stops dsh (verified against a real mock server)
// Run: node scripts/sim.mjs   (after `npm run compile`)
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
// Keep test artifacts inside the workspace (sandbox-friendly); cleanup at exit.
const dataDir = path.join(process.cwd(), '.sim-tmp')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
process.env.DSH_VSCODE_DATA_DIR = dataDir

const { acquireStartupLock, releaseStartupLock, readInstance, writeInstance, registerWindow, unregisterWindow, isAlive } = require('../out/instance.js')
const { DshRuntime } = require('../out/runtime.js')

let failures = 0
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
  if (!cond) failures++
}

// --- mock dsh server (listens on a fixed port, serves the DSH bootstrap page)
const MOCK_PORT = 45678
const server = spawn(process.execPath, ['-e', `
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>window.__DSH_BOOT__ = {}</html>');
  }).listen(${MOCK_PORT}, '127.0.0.1');
`], { stdio: 'ignore' })
const mockPid = server.pid

function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (Date.now() > deadline) return resolve(false)
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => {
        sock.destroy()
        setTimeout(tick, 200)
      })
    }
    tick()
  })
}

const runtimeA = new DshRuntime({ app: 'Sim', windowPid: 1001, port: MOCK_PORT, channel: 'latest', command: '', dshHome: '' })
const runtimeB = new DshRuntime({ app: 'Sim', windowPid: 1002, port: MOCK_PORT, channel: 'latest', command: '', dshHome: '' })

async function main() {
  await waitPort(MOCK_PORT, 10_000)

  // 1. first window acquires the lock; a second window cannot while it is held
  const lockA = acquireStartupLock('Sim')
  check('window A acquires the startup lock', lockA !== null)
  check('window B cannot acquire while A holds it', acquireStartupLock('Sim') === null)
  releaseStartupLock()

  // 2. A registers itself and records dsh (managed)
  let inst = readInstance()
  inst.dsh = { pid: mockPid, port: MOCK_PORT, managedBy: 'extension', startedAt: new Date().toISOString() }
  inst = registerWindow(inst, 'Sim', 1001)
  writeInstance(inst)
  check('registry records dsh pid alive', isAlive(mockPid))

  // 3. B (second window) attaches
  inst = readInstance()
  inst = registerWindow(inst, 'Sim', 1002)
  writeInstance(inst)
  check('two windows registered', readInstance().windows.length === 2)

  // 4. A closes (not the last window): dsh must survive
  const stoppedByA = runtimeA.shutdownBookkeeping()
  await new Promise((r) => setTimeout(r, 300))
  check('closing non-last window does not stop dsh', stoppedByA === false && isAlive(mockPid))
  check('after A closes, one window remains', readInstance().windows.length === 1)

  // 5. B closes (last window): dsh must be stopped
  const stoppedByB = runtimeB.shutdownBookkeeping()
  await new Promise((r) => setTimeout(r, 500))
  check('closing last window stops dsh', stoppedByB === true && !isAlive(mockPid))
  check('registry dsh record cleared', readInstance().dsh === null)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
