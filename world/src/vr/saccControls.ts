/**
 * saccControls — SaccFlight-style hand controls for the engine's VR control
 * block (fsvr.h FsVrControlDataPointer), ported from ysflight-web's
 * fswebxr.cpp processControllerPlain and reduced to what XRift leaves us.
 *
 *   right grip   squeeze = take the stick; wrist pitch/yaw/roll since the
 *                grab -> elevator / rudder / aileron (45 deg = full)
 *   left grip    squeeze = take the throttle; push forward 17 cm = 0..1;
 *                shove 3 cm past the stop = afterburner (Tab), pull back
 *                below 0.95 = afterburner off
 *   both grips   double-squeeze within 250 ms latches the grab (sticky);
 *                the next squeeze+release ends it
 *   thumbsticks  push past 0.5 to pick one of six functions (sticky pick);
 *                that hand's trigger fires the picked function
 *   right B      air brake / spoiler toggle (engine key B)
 *
 * The host owns the remaining buttons while seated: right A stands up,
 * left X toggles the mic, left Y the dashboard, right thumbstick turn is
 * disabled while seated and the left thumbstick also reaches the seat's
 * onControlInput (which the seats ignore while this is active).
 */
import { Quaternion, Vector3 } from 'three'
import type { Hand, XrSample } from './xrHands'

export interface DialEntry { label: string; code: string; mode: 'tap' | 'hold' }

export const RIGHT_DIAL: DialEntry[] = [
  { label: 'Gun', code: 'Space', mode: 'hold' },
  { label: '武器切替', code: 'Digit2', mode: 'tap' },
  { label: 'フレア', code: 'Digit4', mode: 'hold' },
  { label: 'Gear', code: 'KeyG', mode: 'tap' },
  { label: 'Brake', code: 'KeyB', mode: 'tap' },
  { label: 'レーダー', code: 'Digit3', mode: 'tap' },
]
export const LEFT_DIAL: DialEntry[] = [
  { label: 'Flap↑', code: 'KeyR', mode: 'tap' },
  { label: 'Smoke', code: 'KeyP', mode: 'tap' },
  { label: 'A/B', code: 'Tab', mode: 'tap' },
  { label: 'Flap↓', code: 'KeyF', mode: 'tap' },
  { label: 'トリム', code: 'KeyT', mode: 'hold' },
  { label: 'Brake', code: 'KeyB', mode: 'tap' },
]

const MAX_ANGLE = Math.PI / 4
const THROTTLE_SENS = 6
const GRAB_THRESHOLD = 0.75
const TRIGGER_THRESHOLD = 0.5
const STICKY_DOUBLE_MS = 250
const AB_OVERSHOOT_M = 0.03
const AB_SHOVE_SPEED_MPS = 0.15
const AB_DISENGAGE_VALUE = 0.95
const YAW_DEADZONE_RAD = (6 * Math.PI) / 180
const DIAL_SELECT_THRESHOLD = 0.5
const DIAL_HYSTERESIS_DEG = 6
const DIAL_VISIBLE_THRESHOLD = 0.3
const DIAL_HIDE_DELAY_MS = 1200

// Control block indices (fsvr.h)
const C_GRABBED = 0, C_AIL = 1, C_ELV = 2, C_RUD = 3, C_THR_GRABBED = 4, C_THR = 5, C_THR_EVER = 6, C_CONFIRM = 7, C_STICK_EVER = 8

export interface KeySink {
  /** Hold / release an engine key (KeyboardEvent.code). */
  edge(code: string, down: boolean): void
}

interface Sticky { latched: boolean; prevPhys: boolean; lastReleaseAt: number; disengageArmed: boolean }
export interface DialState {
  sel: number | null
  picking: boolean
  visible: boolean
  hideAt: number
  engaged: DialEntry | null
  prevTrigger: boolean
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

function applyDeadzone(angle: number, dz: number, max: number): number {
  const mag = Math.abs(angle)
  if (mag <= dz) return 0
  const r = (mag - dz) / (max - dz)
  return clamp(angle < 0 ? -r : r, -1, 1)
}

/** Shared read-only status for the beacon / tests. */
export const saccStatus = {
  active: false,
  right: { grabbed: false, sel: -1, visible: false, pos: [0, 0, 0] as number[] },
  left: { grabbed: false, sel: -1, visible: false, pos: [0, 0, 0] as number[] },
  /** Keys dispatched so far and the last one. */
  keys: 0,
  lastKey: '' as string,
  ail: 0, elv: 0, rud: 0, thr: 0, ab: false,
}

export class SaccControls {
  private sticky: Record<Hand, Sticky> = { left: SaccControls.newSticky(), right: SaccControls.newSticky() }
  readonly dial: Record<Hand, DialState> = { left: SaccControls.newDial(), right: SaccControls.newDial() }
  private stick = { grabbed: false, q0: new Quaternion(), ever: false }
  private thr = { grabbed: false, p0: new Vector3(), fwd0: new Vector3(0, 0, -1), base: 0, value: 0, ever: false, abEngaged: false, lastPushM: 0, lastT: 0 }
  private held = new Set<string>()
  private tapRelease: string[] = []
  /** Set once update() has written the block; detach() clears it. */
  engaged = false
  private tmpQ = new Quaternion()
  private tmpV = new Vector3()

  constructor(private keys: KeySink) {}

  private static newSticky(): Sticky { return { latched: false, prevPhys: false, lastReleaseAt: 0, disengageArmed: false } }
  private static newDial(): DialState { return { sel: null, picking: false, visible: false, hideAt: 0, engaged: null, prevTrigger: false } }

  private haptic(gp: Gamepad | null, strength = 0.25, ms = 50): void {
    try {
      const act = (gp as unknown as { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => unknown }> } | null)?.hapticActuators?.[0]
      act?.pulse?.(strength, ms)
    } catch { /* no haptics */ }
  }

  private keyEdge(code: string, down: boolean): void {
    if (down === this.held.has(code)) return
    if (down) this.held.add(code); else this.held.delete(code)
    this.keys.edge(code, down)
    saccStatus.keys++
    saccStatus.lastKey = code
  }

  /** A real tap: key down now, key up on the next update (no timers). */
  private keyTap(code: string): void {
    this.keys.edge(code, true)
    this.tapRelease.push(code)
    saccStatus.keys++
    saccStatus.lastKey = code
  }

  private updateSticky(s: Sticky, phys: boolean, now: number, gp: Gamepad | null): boolean {
    const pressEdge = phys && !s.prevPhys
    const releaseEdge = !phys && s.prevPhys
    if (!s.latched) {
      if (pressEdge) {
        if (s.lastReleaseAt > 0 && now - s.lastReleaseAt <= STICKY_DOUBLE_MS) {
          s.latched = true
          s.disengageArmed = false
          this.haptic(gp, 0.4, 120)
        }
      } else if (releaseEdge) s.lastReleaseAt = now
    } else if (pressEdge) {
      s.disengageArmed = true
    } else if (releaseEdge && s.disengageArmed) {
      s.latched = false
      s.disengageArmed = false
      s.lastReleaseAt = now
      this.haptic(gp)
    }
    s.prevPhys = phys
    return s.latched
  }

  private pickSector(d: DialState, x: number, upY: number, n: number, gp: Gamepad | null): void {
    let deg = (Math.atan2(x, upY) * 180) / Math.PI
    if (deg < 0) deg += 360
    let idx = Math.round(deg / (360 / n)) % n
    const cur = d.sel
    if (cur !== null && idx !== cur) {
      const half = 180 / n
      const curCen = cur * (360 / n)
      const away = Math.abs(((((deg - curCen) % 360) + 540) % 360) - 180)
      if (away <= half + DIAL_HYSTERESIS_DEG) idx = cur
    }
    if (idx !== cur) {
      d.sel = idx
      this.haptic(gp)
    }
  }

  private updateDial(d: DialState, thumb: [number, number], n: number, now: number, gp: Gamepad | null): void {
    const x = thumb[0]
    const upY = -thumb[1]
    const mag = Math.hypot(x, upY)
    if (mag > DIAL_SELECT_THRESHOLD) {
      if (!d.picking) { d.picking = true; d.sel = null } // fresh gesture: no hysteresis bias from the last one
      this.pickSector(d, x, upY, n, gp)
    } else d.picking = false
    if (mag > DIAL_VISIBLE_THRESHOLD) { d.visible = true; d.hideAt = now + DIAL_HIDE_DELAY_MS }
    else if (d.visible && now >= d.hideAt) d.visible = false
  }

  private updateTrigger(d: DialState, table: DialEntry[], trigger: number, gp: Gamepad | null): void {
    const pressed = trigger > TRIGGER_THRESHOLD
    const edgeUp = pressed && !d.prevTrigger
    if (edgeUp) {
      this.haptic(gp)
      d.engaged = d.sel === null ? null : table[d.sel]
    }
    if (d.engaged) {
      if (d.engaged.mode === 'hold') this.keyEdge(d.engaged.code, pressed)
      else if (edgeUp) this.keyTap(d.engaged.code)
      if (!pressed) d.engaged = null
    }
    d.prevTrigger = pressed
  }

  /** One XR frame. Writes the control block at f[c..c+8]. */
  update(s: XrSample, f: Float32Array, c: number, now: number): void {
    // Finish last frame's taps first (one frame of key-down is a real tap).
    for (const code of this.tapRelease) this.keys.edge(code, false)
    this.tapRelease.length = 0
    this.engaged = true

    // ---- right hand: stick + right dial + B brake
    const r = s.hands.right
    const rPhys = r.tracked && r.squeeze > GRAB_THRESHOLD
    const rSticky = this.updateSticky(this.sticky.right, rPhys, now, r.gamepad)
    const stickGrabbed = r.tracked && (rPhys || rSticky)
    const st = this.stick
    if (stickGrabbed && !st.grabbed) { st.q0.copy(r.quat); this.haptic(r.gamepad) }
    else if (!stickGrabbed && st.grabbed) this.haptic(r.gamepad)
    st.grabbed = stickGrabbed
    if (stickGrabbed) {
      // dq = q * conj(q0): rotation since the grab, in reference-space axes
      const dq = this.tmpQ.copy(st.q0).invert().premultiply(r.quat)
      const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(dq)
      const pitch = Math.asin(clamp(fwd.y, -1, 1))
      const yaw = Math.atan2(-fwd.x, -fwd.z)
      const right = this.tmpV.set(1, 0, 0).applyQuaternion(dq)
      const roll = Math.asin(clamp(right.y, -1, 1))
      const elv = clamp(pitch / MAX_ANGLE, -1, 1)
      const rud = applyDeadzone(yaw, YAW_DEADZONE_RAD, MAX_ANGLE)
      const ail = clamp(-roll / MAX_ANGLE, -1, 1)
      f[c + C_GRABBED] = 1
      f[c + C_AIL] = ail
      f[c + C_ELV] = elv
      f[c + C_RUD] = rud
      f[c + C_STICK_EVER] = 1
      st.ever = true
      saccStatus.ail = ail; saccStatus.elv = elv; saccStatus.rud = rud
    } else {
      f[c + C_GRABBED] = 0
      f[c + C_AIL] = 0; f[c + C_ELV] = 0; f[c + C_RUD] = 0
      if (st.ever) f[c + C_STICK_EVER] = 1
      saccStatus.ail = 0; saccStatus.elv = 0; saccStatus.rud = 0
    }
    if (r.gamepad) {
      this.updateDial(this.dial.right, r.thumb, RIGHT_DIAL.length, now, r.gamepad)
      this.updateTrigger(this.dial.right, RIGHT_DIAL, r.trigger, r.gamepad)
      this.keyEdge('KeyB', r.b) // engine toggles the spoiler on the key-down edge
    }

    // ---- left hand: throttle + left dial
    const l = s.hands.left
    const lPhys = l.tracked && l.squeeze > GRAB_THRESHOLD
    const lSticky = this.updateSticky(this.sticky.left, lPhys, now, l.gamepad)
    const thrGrabbed = l.tracked && (lPhys || lSticky)
    const th = this.thr
    if (thrGrabbed && !th.grabbed) {
      th.p0.copy(l.pos)
      const fwd = this.tmpV.set(0, 0, -1).applyQuaternion(s.viewerQuat)
      fwd.y = 0
      if (fwd.lengthSq() > 1e-8) th.fwd0.copy(fwd.normalize()); else th.fwd0.set(0, 0, -1)
      th.base = th.value
      th.lastPushM = 0
      th.lastT = 0
      this.haptic(l.gamepad)
    } else if (!thrGrabbed && th.grabbed) this.haptic(l.gamepad)
    th.grabbed = thrGrabbed
    if (thrGrabbed) {
      const pushM = this.tmpV.copy(l.pos).sub(th.p0).dot(th.fwd0)
      const raw = th.base + pushM * THROTTLE_SENS
      const value = clamp(raw, 0, 1)
      f[c + C_THR_GRABBED] = 1
      f[c + C_THR] = value
      f[c + C_THR_EVER] = 1
      th.value = value
      th.ever = true
      const dtS = th.lastT > 0 ? (now - th.lastT) / 1000 : 0
      const shove = dtS > 0 ? (pushM - th.lastPushM) / dtS : 0
      th.lastPushM = pushM
      th.lastT = now
      const overshoot = (raw - 1) / THROTTLE_SENS
      if (!th.abEngaged) {
        if (value >= 1 && overshoot >= AB_OVERSHOOT_M && shove >= AB_SHOVE_SPEED_MPS) {
          th.abEngaged = true
          this.keyTap('Tab')
          this.haptic(l.gamepad, 0.5, 120)
        }
      } else if (value < AB_DISENGAGE_VALUE) {
        th.abEngaged = false
        this.keyTap('Tab')
        this.haptic(l.gamepad, 0.5, 120)
      }
    } else {
      f[c + C_THR_GRABBED] = 0 // [5] stays: a lever rests where it was left
      if (th.ever) f[c + C_THR_EVER] = 1
    }
    if (l.gamepad) {
      this.updateDial(this.dial.left, l.thumb, LEFT_DIAL.length, now, l.gamepad)
      this.updateTrigger(this.dial.left, LEFT_DIAL, l.trigger, l.gamepad)
    }

    f[c + C_CONFIRM] = r.trigger > TRIGGER_THRESHOLD || l.trigger > TRIGGER_THRESHOLD ? 1 : 0

    saccStatus.active = true
    saccStatus.right.grabbed = stickGrabbed
    saccStatus.right.sel = this.dial.right.sel ?? -1
    saccStatus.right.visible = this.dial.right.visible
    saccStatus.left.grabbed = thrGrabbed
    saccStatus.left.sel = this.dial.left.sel ?? -1
    saccStatus.left.visible = this.dial.left.visible
    saccStatus.thr = th.value
    saccStatus.ab = th.abEngaged
  }

  /** Let go of everything (seat left, session ended, component unmounted). */
  detach(f: Float32Array | null, c: number): void {
    for (const code of this.tapRelease) this.keys.edge(code, false)
    this.tapRelease.length = 0
    for (const code of Array.from(this.held)) this.keyEdge(code, false)
    if (f) {
      f[c + C_GRABBED] = 0
      f[c + C_AIL] = 0; f[c + C_ELV] = 0; f[c + C_RUD] = 0
      f[c + C_THR_GRABBED] = 0
      // Hand the throttle back to the keyboard (Q/A): while [6] is set the
      // engine takes the throttle from the block every frame, so a session
      // that once used the hands would otherwise have dead keys for good.
      f[c + C_THR_EVER] = 0
      f[c + C_CONFIRM] = 0
    }
    this.stick.grabbed = false
    this.thr.grabbed = false
    this.thr.ever = false
    for (const h of ['left', 'right'] as Hand[]) {
      this.sticky[h] = SaccControls.newSticky()
      this.dial[h] = SaccControls.newDial()
    }
    this.engaged = false
    saccStatus.active = false
    saccStatus.right.grabbed = false; saccStatus.right.sel = -1; saccStatus.right.visible = false
    saccStatus.left.grabbed = false; saccStatus.left.sel = -1; saccStatus.left.visible = false
    saccStatus.ail = 0; saccStatus.elv = 0; saccStatus.rud = 0
  }
}
