/**
 * Where the running engine instance lives.
 *
 * NOT React state/props: handing the Emscripten Module object to a React
 * component as a prop (even nested inside another object) crashes the Chrome
 * tab outright ("Target crashed") on re-render — observed 2026-11-08 with
 * React 19 / R3F 9 / Vite 7 dev.  Cause unknown; a module-level store with
 * useSyncExternalStore sidesteps it and is the cleaner shape anyway (one
 * engine per page).
 */
import { useSyncExternalStore } from 'react'
import type { YsflightModule } from './types'

let current: YsflightModule | null = null
const listeners = new Set<() => void>()

export function setEngine(m: YsflightModule | null): void {
  current = m
  listeners.forEach((l) => l())
}

export function getEngine(): YsflightModule | null {
  return current
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Re-renders when the engine instance changes. */
export function useEngine(): YsflightModule | null {
  return useSyncExternalStore(subscribe, getEngine, getEngine)
}

// ---- piloting gate -------------------------------------------------------
// Keyboard input is forwarded to the engine only while the local user sits
// in the cockpit seat.  Observed on the production host (2026-11-08): keys
// pass straight through to the world, so without this gate a bystander's
// Tab (afterburner) would launch the parked aircraft.
let piloting = false
export function setPiloting(on: boolean): void {
  piloting = on
}
export function isPiloting(): boolean {
  return piloting
}
