/**
 * gamepadStick — a game controller (or a flight stick) as the pilot's
 * controls, read from the browser's Gamepad API by the world.
 *
 * The engine could read the pad itself (the Emscripten platform layer polls
 * it as joystick 0), but its control assignment is the keyboard table the
 * world writes (loadEngine.ts) and has no joystick lines; and a pad the
 * engine reads would be one more writer of the stick beside the control
 * bus.  So the pad is a source on the bus like the mouse and the VR hands.
 *
 * Standard-mapping pad (Xbox / DualSense / Switch Pro layout):
 *
 *   left stick        aileron / elevator (pull back = nose up)
 *   right stick X     rudder
 *   RT / LT           throttle up / down, at a rate set by how far the
 *                     trigger is pulled (the lever stays where it is left)
 *   A                 fire (held)             B   select weapon
 *   X                 brake / spoiler         Y   landing gear
 *   LB / RB           flap up / flap down
 *   L3                afterburner             R3  radar
 *   d-pad up          flare (held)            d-pad down  smoke
 *   d-pad left        auto trim (held)
 *
 * Back, Start and d-pad right are left alone (the host may use them).
 *
 * Any other device (mapping "": a flight stick, a HOTAS) gets only what can
 * be assumed without asking: axes 0/1 are the stick, button 0 fires.  Its
 * twist, throttle and hat sit on axes that differ per model.
 *
 * Ownership follows the bus rules.  The pad holds the stick only while a
 * stick is off centre, plus one frame of zeros after it comes back (the
 * engine keeps the last value it was given: without that frame a stick let
 * go at speed would leave the rudder where the last sample was).  The
 * throttle is the bus's while a trigger is pulled and goes back to the Q/A
 * keys when both are released, at the value it was left.
 */
import { controlBus } from './controlBus'
import { setFire } from './fireKey'
import type { YsflightModule } from './types'

const STICK_DEADZONE = 0.12
const RUDDER_DEADZONE = 0.15
const TRIGGER_DEADZONE = 0.05
const THROTTLE_RATE = 0.6 // per second at a fully pulled trigger
const EXPO = 1.5 // deflection^EXPO: a thumbstick's throw is short, the middle of it should be gentle

type Mode = 'tap' | 'hold'
const BUTTONS: Array<{ index: number; code: string; mode: Mode }> = [
  { index: 0, code: 'Space', mode: 'hold' },
  { index: 1, code: 'Digit2', mode: 'tap' },
  { index: 2, code: 'KeyB', mode: 'tap' },
  { index: 3, code: 'KeyG', mode: 'tap' },
  { index: 4, code: 'KeyR', mode: 'tap' },
  { index: 5, code: 'KeyF', mode: 'tap' },
  { index: 10, code: 'Tab', mode: 'tap' },
  { index: 11, code: 'Digit3', mode: 'tap' },
  { index: 12, code: 'Digit4', mode: 'hold' },
  { index: 13, code: 'KeyP', mode: 'tap' },
  { index: 14, code: 'KeyT', mode: 'hold' },
]
const BUTTONS_PLAIN: typeof BUTTONS = [{ index: 0, code: 'Space', mode: 'hold' }]

/** Read-only status for the beacon / tests. */
export const padStatus = {
  /** A usable pad is connected (pads appear after their first button press: Gamepad spec). */
  connected: false,
  id: '',
  standard: false,
  /** The pad holds the stick this frame. */
  active: false,
  ail: 0, elv: 0, rud: 0,
  /** The pad moves the throttle this frame. */
  throttling: false,
  keys: 0,
  lastKey: '',
}

const prev = new Map<number, boolean>()
const held = new Set<string>()
const tapRelease: string[] = []
let stickWas = false
let rudWas = false
let throttleOurs = false

function curve(v: number, deadzone: number): number {
  const m = Math.abs(v)
  if (m <= deadzone) return 0
  const r = Math.min(1, (m - deadzone) / (1 - deadzone))
  return Math.sign(v) * Math.pow(r, EXPO)
}

function findPad(): Gamepad | null {
  let pads: (Gamepad | null)[]
  try { pads = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [] } catch { return null } // blocked by a permissions policy
  let plain: Gamepad | null = null
  for (const p of pads) {
    if (!p || !p.connected || p.mapping === 'xr-standard' || p.axes.length < 2) continue
    if (p.mapping === 'standard') return p
    plain ??= p
  }
  return plain
}

function key(mod: YsflightModule, code: string, down: boolean): void {
  if (code === 'Space') setFire(mod, 'gamepad', down) // shared with Shift and the right mouse button
  else mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, down ? 1 : 0])
  if (down) { padStatus.keys++; padStatus.lastKey = code }
}

/** Let go of everything the pad holds (the pilot left the seat, the session went immersive, the pad was unplugged). */
export function releaseGamepad(mod: YsflightModule | null): void {
  if (mod) {
    for (const code of tapRelease) key(mod, code, false)
    for (const code of held) key(mod, code, false)
  }
  tapRelease.length = 0
  held.clear()
  prev.clear()
  if (throttleOurs) { throttleOurs = false; controlBus.throttleToKeys() }
  stickWas = false
  rudWas = false
  padStatus.active = false
  padStatus.throttling = false
  padStatus.ail = padStatus.elv = padStatus.rud = 0
}

/**
 * Once per frame while the local pilot flies outside an immersive session.
 * `throttleNow` is the engine's current throttle (flight data [7]), where
 * the lever starts from when a trigger is first pulled.
 */
export function updateGamepad(mod: YsflightModule, dt: number, throttleNow: number): void {
  for (const code of tapRelease) key(mod, code, false) // the engine sees key-state edges per step: a tap lasts one frame
  tapRelease.length = 0

  const pad = findPad()
  if (!pad) {
    if (padStatus.connected) { padStatus.connected = false; padStatus.id = ''; releaseGamepad(mod) }
    return
  }
  const standard = pad.mapping === 'standard'
  padStatus.connected = true
  padStatus.id = pad.id
  padStatus.standard = standard

  // ---- stick and rudder ----
  // Radial dead zone on the stick, so a diagonal is not clipped to a square.
  const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0
  const m = Math.hypot(x, y)
  let ail = 0, elv = 0
  if (m > STICK_DEADZONE) {
    const r = Math.pow(Math.min(1, (m - STICK_DEADZONE) / (1 - STICK_DEADZONE)), EXPO)
    ail = Math.max(-1, Math.min(1, (x / m) * r))
    elv = Math.max(-1, Math.min(1, (y / m) * r)) // stick pulled back (+y) = nose up
  }
  const rud = standard ? -curve(pad.axes[2] ?? 0, RUDDER_DEADZONE) : 0 // bus: + = nose left
  const stickNow = ail !== 0 || elv !== 0
  const rudNow = rud !== 0
  const hold = stickNow || rudNow || stickWas || rudWas
  if (hold) controlBus.stick('gamepad', ail, elv, rudNow || rudWas ? rud : undefined)
  stickWas = stickNow
  rudWas = rudNow
  padStatus.active = hold
  padStatus.ail = ail
  padStatus.elv = elv
  padStatus.rud = rud

  // ---- throttle ----
  const up = standard ? (pad.buttons[7]?.value ?? 0) : 0
  const down = standard ? (pad.buttons[6]?.value ?? 0) : 0
  const rate = (up > TRIGGER_DEADZONE ? up : 0) - (down > TRIGGER_DEADZONE ? down : 0)
  const pulled = up > TRIGGER_DEADZONE || down > TRIGGER_DEADZONE
  if (pulled) {
    const cur = throttleOurs ? (controlBus.throttleValue() ?? throttleNow) : throttleNow
    controlBus.throttle(cur + rate * THROTTLE_RATE * Math.max(0, Math.min(dt, 0.1)))
    throttleOurs = true
  } else if (throttleOurs) {
    throttleOurs = false
    controlBus.throttleToKeys()
  }
  padStatus.throttling = pulled

  // ---- buttons ----
  for (const b of standard ? BUTTONS : BUTTONS_PLAIN) {
    const now = !!pad.buttons[b.index]?.pressed
    const was = prev.get(b.index) ?? false
    if (now === was) continue
    prev.set(b.index, now)
    if (b.mode === 'tap') {
      if (now) { key(mod, b.code, true); tapRelease.push(b.code) }
    } else if (now) { key(mod, b.code, true); held.add(b.code) }
    else { key(mod, b.code, false); held.delete(b.code) }
  }
}
