/**
 * gauges — the numbers a headset cannot show any other way: frame rate, the
 * engine's cost per frame, and the wasm heap.  A standalone headset browser
 * has no devtools, so the session panel prints these and the player reads
 * them aloud; nothing is sent anywhere.
 *
 * Two readings: what is happening now, and the last flight (while seated: the
 * flight so far).  Frame rate on the ground says little about flying, and a
 * pilot cannot read the panel from the cockpit, so the flight row is what
 * remains to be read after climbing out.
 *
 * Memory comes from the engine's heap gauge (fsvr.h FsVrMemSample: mallinfo
 * walks the whole heap, so it is sampled every 5 s, never per frame).  An
 * engine binary built before that gauge still reports the heap size.
 */
import type { YsflightModule } from '../engine/types'
import { isPiloting } from '../engine/engineStore'

const WINDOW_S = 1 // one frame-rate reading per second
const MEM_EVERY_S = 5

export interface GaugeNow { fps: number; simMs: number; drawMs: number; drawsPerFrame: number; heapMB: number; usedMB: number | null }
export interface GaugeFlight { seconds: number; fpsAvg: number; fpsMin: number; simMs: number; drawMs: number; heapStartMB: number; heapEndMB: number; usedStartMB: number | null; usedEndMB: number | null; live: boolean }

let now: GaugeNow | null = null
let flight: GaugeFlight | null = null

// The window being filled.
let wT = 0
let wFrames = 0
let wDraws = 0
let memT = MEM_EVERY_S // sample on the first window
let heapMB = 0
let usedMB: number | null = null
// The flight being flown.
let fl: { windows: number; fpsSum: number; fpsMin: number; simSum: number; drawSum: number; heap0: number; used0: number | null } | null = null

function sampleMem(mod: YsflightModule): void {
  heapMB = mod.HEAPU8.byteLength / 1048576
  if (mod._FsVrMemSample && mod._FsVrMemDataPointer) {
    mod._FsVrMemSample()
    const b = mod._FsVrMemDataPointer() >> 2
    heapMB = mod.HEAPF32[b]
    usedMB = mod.HEAPF32[b + 1]
  }
}

/** One engine draw happened (per eye in XR). */
export function gaugeCountDraw(): void { wDraws++ }

/** Call once per host frame.  Returns true when the readings changed. */
export function gaugeFrame(mod: YsflightModule, dt: number): boolean {
  wT += dt
  wFrames++
  if (wT < WINDOW_S) return false
  memT += wT
  const piloting = isPiloting()
  // At a flight's start and end the reading must be fresh, not up to 5 s old.
  if (memT >= MEM_EVERY_S || piloting !== !!fl) { memT = 0; sampleMem(mod) }
  const fps = wFrames / wT
  now = { fps, simMs: mod._YsfxGetIntervalMs(), drawMs: mod._YsfxGetDrawMs(), drawsPerFrame: wDraws / wFrames, heapMB, usedMB }
  if (piloting) {
    if (!fl) fl = { windows: 0, fpsSum: 0, fpsMin: Infinity, simSum: 0, drawSum: 0, heap0: heapMB, used0: usedMB }
    fl.windows++
    fl.fpsSum += fps
    fl.fpsMin = Math.min(fl.fpsMin, fps)
    fl.simSum += now.simMs
    fl.drawSum += now.drawMs * now.drawsPerFrame
  }
  if (fl) {
    flight = { seconds: fl.windows * WINDOW_S, fpsAvg: fl.fpsSum / fl.windows, fpsMin: fl.fpsMin, simMs: fl.simSum / fl.windows, drawMs: fl.drawSum / fl.windows,
      heapStartMB: fl.heap0, heapEndMB: heapMB, usedStartMB: fl.used0, usedEndMB: usedMB, live: piloting }
    if (!piloting) fl = null
  }
  wT = 0
  wFrames = 0
  wDraws = 0
  return true
}

export function gaugeNow(): GaugeNow | null { return now }
export function gaugeFlight(): GaugeFlight | null { return flight }

const mb = (heap: number, used: number | null) => (used === null ? `${heap.toFixed(0)}MB` : `${heap.toFixed(0)}MB (use ${used.toFixed(0)})`)

/** The panel's three lines.  ASCII and common kana/kanji only: the host's default font lacks rarer glyphs. */
export function gaugeLines(): [string, string, string] {
  const n = now
  const f = flight
  const a = n
    ? `いま  ${n.fps.toFixed(0)}fps  計算 ${n.simMs.toFixed(1)}ms  描画 ${n.drawMs.toFixed(1)}ms x${n.drawsPerFrame.toFixed(0)}  メモリ ${mb(n.heapMB, n.usedMB)}`
    : 'いま  -'
  if (!f) return [a, '前回の飛行  -', '']
  return [
    a,
    `${f.live ? '飛行中' : '前回の飛行'} ${f.seconds.toFixed(0)}秒  平均 ${f.fpsAvg.toFixed(0)}fps  最低 ${f.fpsMin.toFixed(0)}fps  計算 ${f.simMs.toFixed(1)}ms  描画 ${f.drawMs.toFixed(1)}ms`,
    `  メモリ ${mb(f.heapStartMB, f.usedStartMB)} -> ${mb(f.heapEndMB, f.usedEndMB)}`,
  ]
}
