/**
 * The engine's loadout editor (fsvr.h FsVrLoadoutDataPointer, ysflight-xrift
 * fork): the loading tab of the original aircraft chooser, kept by the
 * engine for one aircraft template.  The kiosk shows the numbers and asks
 * for changes; the rules (hard-point capacity, what a full pylon pushes off,
 * the session's weapon permissions) stay in the engine, which applies the
 * result to the next join for that template.
 */
import type { YsflightModule } from '../engine/types'

/** FSWEAPONTYPE (fsdef.h) -> what the kiosk calls it.  ASCII: the host's default font has no glyph for much else. */
export const WEAPON_LABEL: Record<number, string> = {
  1: 'AIM-9', 10: 'AIM-9X', 6: 'AIM-120', 2: 'AGM-65',
  3: 'BOMB 500', 7: 'BOMB 250', 9: 'BOMB 500HD', 4: 'ROCKET',
  5: 'FLARE', 12: 'FUEL TANK',
}

export interface LoadoutSlot { type: number; num: number; max: number; step: number }
export interface Loadout {
  valid: boolean
  rev: number
  /** Fuel percent the join takes. */
  fuel: number
  smoke: boolean
  smokeGenerators: number
  slots: LoadoutSlot[]
}
/** What the player's aircraft really carries (written while it exists). */
export interface Carried { valid: boolean; counts: number[]; fuelFraction: number; smokeOilKg: number }

const SLOT0 = 8
const SLOT_STRIDE = 4
const CARRIED0 = 50

function base(m: YsflightModule): number { return m._FsVrLoadoutDataPointer() >> 2 }

export function loadoutRevision(m: YsflightModule): number { return m.HEAPF32[base(m) + 1] }

export function readLoadout(m: YsflightModule): Loadout {
  const p = base(m)
  const f = m.HEAPF32
  const n = Math.min(10, f[p + 5])
  const slots: LoadoutSlot[] = []
  for (let k = 0; k < n; k++) {
    const b = p + SLOT0 + SLOT_STRIDE * k
    slots.push({ type: f[b], num: f[b + 1], max: f[b + 2], step: Math.max(1, f[b + 3]) })
  }
  return { valid: f[p] !== 0, rev: f[p + 1], fuel: f[p + 2], smoke: f[p + 3] > 0.5, smokeGenerators: f[p + 4], slots }
}

export function readCarried(m: YsflightModule): Carried {
  const p = base(m)
  const f = m.HEAPF32
  const n = Math.min(10, f[p + 5])
  return { valid: f[p + 62] !== 0, counts: Array.from(f.subarray(p + CARRIED0, p + CARRIED0 + n)), fuelFraction: f[p + 60], smokeOilKg: f[p + 61] }
}

/** Start over from the template's default loading. */
export function loadoutSetAircraft(m: YsflightModule, air: string): void {
  m.ccall('FsVrLoadoutSetAircraft', null, ['string'], [air])
}
/** Ask for `n` of a weapon; the engine clamps to what the aircraft can carry. */
export function loadoutChange(m: YsflightModule, type: number, n: number): void {
  m._FsVrLoadoutChange(type, Math.max(0, Math.round(n)))
}
export function loadoutSetFuel(m: YsflightModule, percent: number): void {
  m.HEAPF32[base(m) + 2] = Math.min(100, Math.max(0, Math.round(percent)))
}
export function loadoutSetSmoke(m: YsflightModule, on: boolean): void {
  m.HEAPF32[base(m) + 3] = on ? 1 : 0
}
