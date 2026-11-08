/**
 * StateBeacon — a read-only observation channel for automated tests.
 *
 * Twice a second the world dispatches a `ysfx-state` CustomEvent on window
 * carrying the engine's session state, the player's flight data and the
 * HUD lines.  Tests (Playwright, on the real XRift host or the dev
 * environment) subscribe to it; nothing is written to globals, so the
 * channel passes XRift's code-security rules and ships in production.
 */
import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import { useEngine } from '../engine/engineStore'
import { airBase, airCount, airName, readNetState, type NetState } from './netState'
import type { NetRole } from './NetSession'

export interface YsfxBeacon {
  t: number
  role: NetRole | null
  room: string | null
  net: NetState | null
  flight: number[] | null
  aircraft: Array<{ id: number; alive: boolean; player: boolean; name: string; pos: number[] }>
  hud: string[] | null
}

let hudLines: string[] | null = null
/** FlightHud publishes its lines here (module-level, not a global). */
export function publishHud(lines: string[] | null): void {
  hudLines = lines
}

export function StateBeacon({ role, room }: { role: NetRole | null; room: string | null }) {
  const mod = useEngine()
  const acc = useRef(0)
  const net = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0 })
  useFrame((_s, dt) => {
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    const detail: YsfxBeacon = { t: Date.now(), role, room, net: null, flight: null, aircraft: [], hud: hudLines }
    if (mod) {
      detail.net = { ...readNetState(mod, net.current) }
      const f = mod.HEAPF32
      const d = mod._FsVrFlightDataPointer() >> 2
      detail.flight = Array.from(f.subarray(d, d + 16))
      const n = airCount(mod)
      for (let i = 0; i < n; i++) {
        const b = airBase(mod, i)
        detail.aircraft.push({ id: f[b], alive: f[b + 1] !== 0, player: f[b + 2] !== 0, name: airName(mod, i), pos: [f[b + 15], f[b + 16], f[b + 17]] })
      }
    }
    window.dispatchEvent(new CustomEvent('ysfx-state', { detail }))
  })
  return null
}
