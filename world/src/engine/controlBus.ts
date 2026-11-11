/**
 * controlBus — the one writer of the engine's control block
 * (fsvr.h FsVrControlDataPointer), and the one place that decides which input
 * source owns which axis.
 *
 * Six sources can fly the aircraft: the engine's own keyboard, the host's
 * two-axis seat input (WASD/arrows on a desktop, the joystick on a phone),
 * the mouse stick, a gamepad, the VR hands, the phone's switch panel.  Each used to poke
 * the block's floats itself, and every pairing that nobody had thought about
 * became a bug: Q/A throttle dead, A rolling left, the keyboard dead but for
 * Tab, Z/X/C rudder dead (2026-11-08..10).  All four were the same mistake --
 * a source that held one axis silently took the others with it.
 *
 * So: sources state what they want, per axis group, every frame they want
 * it; `flush` (once per frame, right before the simulation step) picks the
 * owner of each group and writes the block.
 *
 *   stick (aileron + elevator)  highest-priority source that claimed this
 *                               frame; none -> springs to neutral once any
 *                               source has ever claimed (the engine's keys
 *                               never get these axes back while seated).
 *   rudder                      only a stick with a yaw axis owns it: the VR
 *                               twist from its first use until the session
 *                               ends, a gamepad's right stick for the frames
 *                               it claims.  Otherwise the engine's Z/X/C keys do.
 *   throttle                    a lever: stays where it was last put, owned
 *                               by the block from the first touch until
 *                               `throttleToKeys` hands it back to Q/A.
 *
 * A stick claim lasts one frame; the throttle value persists.  Claims made
 * after the flush (the host's seat input and the hands run later in the
 * frame) are consumed by the next frame's flush, as before.
 */
import type { YsflightModule } from './types'

/** The control block's layout: the only copy on the TypeScript side. */
export const CTL = {
  STICK_HELD: 0,   // a source holds the stick this frame
  AIL: 1,          // + = right roll
  ELV: 2,          // + = nose up
  RUD: 3,          // + = nose left
  THR_HELD: 4,     // a hand is on the lever (engine ignores the throttle keys while set)
  THR: 5,          // 0..1
  THR_OWNED: 6,    // the block, not the keys, sets the throttle
  CONFIRM: 7,      // "press any button" for the engine's prompts
  STICK_OWNED: 8,  // the block owns aileron/elevator: neutral when not held
  RUD_OWNED: 11,   // the block owns the rudder too (a stick that twists)
} as const

export type StickSource = 'vr' | 'mouse' | 'gamepad' | 'host'
/** First claimant in this order owns the stick. */
const PRIORITY: StickSource[] = ['vr', 'mouse', 'gamepad', 'host']

interface Claim { on: boolean; ail: number; elv: number; rud: number; yaw: boolean }
const claims: Record<StickSource, Claim> = {
  vr: { on: false, ail: 0, elv: 0, rud: 0, yaw: false },
  mouse: { on: false, ail: 0, elv: 0, rud: 0, yaw: false },
  gamepad: { on: false, ail: 0, elv: 0, rud: 0, yaw: false },
  host: { on: false, ail: 0, elv: 0, rud: 0, yaw: false },
}
let stickOwned = false
let rudOwned = false
const thr = { value: 0, owned: false, held: false }
let parkClaim = false
let confirmClaim = false
let owner: StickSource | null = null

export const controlBus = {
  /** Hold the stick this frame.  Pass `rud` only from a stick that has a yaw axis. */
  stick(src: StickSource, ail: number, elv: number, rud?: number): void {
    const c = claims[src]
    c.on = true
    c.ail = ail
    c.elv = elv
    c.yaw = rud !== undefined
    c.rud = rud ?? 0
  },
  /** Put the throttle lever at `value`; `held` while a hand is on it this frame. */
  throttle(value: number, held = false): void {
    thr.value = Math.min(1, Math.max(0, value))
    thr.owned = true
    if (held) thr.held = true
  },
  /** Where the lever is, or null while the engine's keys own the throttle. */
  throttleValue(): number | null { return thr.owned ? thr.value : null },
  /** Hand the throttle back to the engine's Q/A keys. */
  throttleToKeys(): void { thr.owned = false; thr.held = false },
  /** Nobody aboard: idle throttle this frame, whatever the lever says. */
  park(): void { parkClaim = true },
  /** Answer the engine's "press a button" prompt this frame. */
  confirm(): void { confirmClaim = true },
  /** A source with a yaw axis went away (XR session ended): rudder and throttle back to the keys. */
  releaseYawAndThrottle(): void {
    rudOwned = false
    thr.owned = false
    thr.held = false
    claims.vr.on = false
  },
  /** New engine instance: forget everything. */
  reset(): void {
    for (const s of PRIORITY) claims[s].on = false
    stickOwned = false
    rudOwned = false
    thr.value = 0
    thr.owned = false
    thr.held = false
    parkClaim = false
    confirmClaim = false
    owner = null
  },
  /** Who held the stick at the last flush (for the test beacon). */
  owner(): StickSource | null { return owner },

  /** Resolve this frame's claims into the block.  Once per frame, before the simulation step. */
  flush(mod: YsflightModule): void {
    const f = mod.HEAPF32
    const c = mod._FsVrControlDataPointer() >> 2
    owner = null
    for (const s of PRIORITY) if (claims[s].on) { owner = s; break }
    if (owner) {
      const o = claims[owner]
      stickOwned = true
      if (o.yaw && owner === 'vr') rudOwned = true
      f[c + CTL.STICK_HELD] = 1
      f[c + CTL.AIL] = o.ail
      f[c + CTL.ELV] = o.elv
      f[c + CTL.RUD] = o.yaw ? o.rud : 0
    } else {
      f[c + CTL.STICK_HELD] = 0
      f[c + CTL.AIL] = 0
      f[c + CTL.ELV] = 0
      f[c + CTL.RUD] = 0
    }
    f[c + CTL.STICK_OWNED] = stickOwned ? 1 : 0
    f[c + CTL.RUD_OWNED] = rudOwned || (owner !== null && claims[owner].yaw) ? 1 : 0
    if (parkClaim) {
      f[c + CTL.THR_HELD] = 0
      f[c + CTL.THR] = 0
      f[c + CTL.THR_OWNED] = 1
    } else {
      f[c + CTL.THR_HELD] = thr.held ? 1 : 0
      f[c + CTL.THR] = thr.value
      f[c + CTL.THR_OWNED] = thr.owned ? 1 : 0
    }
    f[c + CTL.CONFIRM] = confirmClaim ? 1 : 0
    for (const s of PRIORITY) claims[s].on = false
    thr.held = false
    parkClaim = false
    confirmClaim = false
  },
}
