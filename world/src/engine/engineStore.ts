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

// ---- render-time hook ------------------------------------------------------
// Runs once per frame at the start of rendering (the engine's draw hook is the
// first object three.js renders), after every frame callback of the host has
// placed the player's body and camera.  The only moment the pose the eye will
// actually be drawn from can be read (net/CockpitSeat.tsx anchors to it).
const beforeDraw = new Set<() => void>()
export function onBeforeEngineDraw(fn: () => void): () => void {
  beforeDraw.add(fn)
  return () => { beforeDraw.delete(fn) }
}
export function runBeforeEngineDraw(): void { beforeDraw.forEach((f) => f()) }

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

// ---- HUD glass texture ----------------------------------------------------
// The engine's real flat HUD rendered off-screen (engine/hudTarget.ts); the
// cockpit glass mesh reads it from here.  Same module-level shape as the
// engine instance (a GL texture is not React state either).
import type { Texture } from 'three'
let hudTexture: Texture | null = null
const hudListeners = new Set<() => void>()
export function setHudTexture(t: Texture | null): void {
  hudTexture = t
  hudListeners.forEach((l) => l())
}
function getHudTexture(): Texture | null { return hudTexture }
function subscribeHud(l: () => void): () => void {
  hudListeners.add(l)
  return () => hudListeners.delete(l)
}
export function useHudTexture(): Texture | null {
  return useSyncExternalStore(subscribeHud, getHudTexture, getHudTexture)
}
