/**
 * How far the engine is from being flyable, for the loading panel.
 *
 *   download  the glue, the 3 MB WebAssembly and the 24 MB data package are
 *             coming in (`progress` 0..1 once the data package reports sizes)
 *   boot      everything is here; the engine is starting
 *   field     the engine runs and is reading the field (start positions,
 *             ground elevation): set by whoever knows the field is ready
 *   ready     flyable
 *
 * Module-level like the engine instance itself (engineStore.ts).
 */
import { useSyncExternalStore } from 'react'

export type LoadStage = 'download' | 'boot' | 'field' | 'ready'
export interface LoadState { stage: LoadStage; progress: number | null }

let state: LoadState = { stage: 'download', progress: null }
const listeners = new Set<() => void>()

export function setLoad(stage: LoadStage, progress: number | null = null): void {
  if (state.stage === stage && state.progress === progress) return
  state = { stage, progress }
  listeners.forEach((l) => l())
}

/** Emscripten's status line: "Downloading data... (loaded/total)". */
export function loadStatusLine(text: string): void {
  if (state.stage !== 'download') return
  const m = /\((\d+)\/(\d+)\)/.exec(text)
  if (!m) return
  const total = Number(m[2])
  if (total > 0) setLoad('download', Math.round((Number(m[1]) / total) * 100) / 100) // 1 % steps: no re-render per chunk
}

function get(): LoadState { return state }
export function loadState(): LoadState { return state }
function subscribe(l: () => void): () => void { listeners.add(l); return () => { listeners.delete(l) } }
export function useLoad(): LoadState { return useSyncExternalStore(subscribe, get, get) }
