/**
 * seatLead — keep the pilot's eye, the avatar and the drawn aircraft together
 * on a moving cockpit.
 *
 * The host reads a seat's surface in its own frame callbacks and moves the
 * player through a kinematic body that the physics step applies a frame
 * later.  Each frame of pipeline delay puts the avatar one frame of travel
 * behind the cockpit (3 m at 350 kt: a third-person pilot stood on the
 * fuselage spine, 2026-11-09), and in VR the eye rides that body.  The
 * desktop first-person camera, by contrast, is placed from the seat surface
 * itself, on time.
 *
 * Measure, then DELAY the visuals -- never lead the seat.  Leading the seat
 * by velocity x delay (v43/v44) amplified every frame-time wobble into
 * judder at speed: the body landed where last frame's velocity estimate
 * put it while the engine drew the aircraft where the simulation really
 * was ("the aircraft shakes even in the cockpit view", toming 2026-11-10).
 *
 * 1. The seat handed to the host is the TRUE pose; the engine's own clock
 *    is continuous (fssimulation.cpp PassedTime, emscripten branch).
 * 2. The body read at the start of our callback is where the host put it for
 *    the previous frame.  Its distance along the velocity behind the
 *    previous frame's seat point, over the speed, is the body's render-time
 *    lag in seconds (`lag`; k-1 frames for a k-frame pipeline, 1 frame on
 *    desktop by measurement).  Settles within a second, holds at low speed.
 * 3. Whatever the eye sees of the aircraft is sampled from the true pose
 *    history `lag` seconds back: the HUD group, and the engine's drawn own
 *    aircraft through FsVrPlayerVisualDataPointer.  Positions interpolate,
 *    attitudes slerp, so no velocity estimate enters the picture.
 *    Desktop first person (camera on the eye point) uses no delay at all;
 *    desktop third person and VR use `lag`.
 * 4. `eFrames` reports the residual between the body and the delayed visual,
 *    in frames of the measured frame time, and `shakeCm` its RMS in
 *    centimetres: how far the avatar (and a VR eye) and the drawn aircraft
 *    move against each other from frame to frame.  The numbers the tests watch.
 *
 * All times come from the frame clock (engine/frameClock.ts), the same one
 * the simulation steps on.
 *
 * Dev stand-in: the local DevEnvironment puts the body on the seat within
 * the same frame, so none of this had anything to measure off the production
 * host.  `setDevBodyLag(n)` makes `readFeet` answer n frames late, which is
 * what the production desktop does (n = 1, measured 16.5 ms at 60 Hz).
 */
import { Matrix4, Quaternion, Vector3 } from 'three'
import { frameClock } from '../engine/frameClock'

const MIN_SPEED = 20 // m/s: below this the measurement is noise (head motion, taxiing)
const MAX_LAG_S = 0.15
const SETTLE_S = 0.5
const HISTORY = 16
const ONE = new Vector3(1, 1, 1)

export interface LagReport { speed: number; eFrames: number; lagMs: number; dtMs: number; jitterCm: number; shakeCm: number; visOn: boolean; visBehindM: number; anchored: boolean; trailM: number; trailShakeCm: number }
let lastLag: LagReport | null = null
/** The seated local user's lag measurement, for the beacon. */
export function seatLag(): LagReport | null { return lastLag }
export function clearSeatLag(): void { lastLag = null }

// ---- dev stand-in for the production host's late body ----------------------
// The production body is a kinematic rigid body: the pose handed in frame F
// becomes its position at the next physics step, and physics steps at its
// own fixed rate.  At a display rate above it (72/90/120 Hz against 60) some
// frames have no step at all: the body, and a VR eye riding it, advances in
// stairs.  `stepHz` reproduces that (0 = one step every frame).
let devLagFrames = 0
let devForce = false
let devStepHz = 0
let devAcc = 0
let devRenderFrame = -1
let devHave = 0
const devBody = new Vector3()
const devPending = new Vector3()
/** Dev only: land the body late (frames 0 = off, else one physics step), optionally anchor as VR / third person would, optionally step physics at `stepHz`. */
export function setDevBodyLag(frames: number, forceDelay = false, stepHz = 0): void {
  devLagFrames = Math.max(0, Math.floor(frames))
  devForce = forceDelay
  devStepHz = Math.max(0, stepHz)
  devAcc = 0
  devHave = 0
}
/** Dev only: treat the desktop first-person view as one whose eye rides the body. */
export function devForceDelay(): boolean { return devForce }

function readFeetNow(users: unknown, out: Vector3): Vector3 | null {
  try {
    const u = users as { getLocalMovement?: () => { position?: unknown } | null }
    const p = u.getLocalMovement?.()?.position as unknown
    if (Array.isArray(p)) return out.set(p[0], p[1], p[2])
    if (p && typeof p === 'object') { const o = p as { x: number; y: number; z: number }; return out.set(o.x, o.y, o.z) }
  } catch { /* no movement API */ }
  return null
}

/** The host's local body (feet) position, if the platform exposes it (array or {x,y,z}). */
export function readFeet(users: unknown, out: Vector3): Vector3 | null {
  const now = readFeetNow(users, out)
  if (!now || devLagFrames === 0) return now
  return devHave === 2 ? out.copy(devBody) : now
}

/**
 * The body position this frame will be RENDERED with: call from the
 * render-time hook (engineStore onBeforeEngineDraw), after the host's frame
 * callbacks.  On the production host this is simply the current value; the dev
 * stand-in advances its late, stepped body here.
 */
export function readFeetAtRender(users: unknown, out: Vector3): Vector3 | null {
  const now = readFeetNow(users, out)
  if (!now || devLagFrames === 0) return now
  if (devRenderFrame !== frameClock.frame) { // once per frame
    devRenderFrame = frameClock.frame
    let step = true
    if (devStepHz > 0) {
      devAcc += frameClock.dt * devStepHz
      step = devAcc >= 1
      if (step) devAcc = Math.min(devAcc - 1, 1)
    }
    if (step && devHave >= 1) { devBody.copy(devPending); devHave = 2 }
    devPending.copy(now)
    if (devHave < 1) devHave = 1
  }
  return devHave === 2 ? out.copy(devBody) : now
}

/** The last few true poses, sampled back in time (position lerp, attitude slerp). */
export class PoseHistory {
  private t: number[] = []
  private pos: Vector3[] = []
  private quat: Quaternion[] = []
  private n = 0
  private head = 0
  private s = new Vector3()
  private p = new Vector3()
  private q = new Quaternion()

  constructor() {
    for (let i = 0; i < HISTORY; i++) { this.t.push(0); this.pos.push(new Vector3()); this.quat.push(new Quaternion()) }
  }

  reset(): void { this.n = 0; this.head = 0 }

  push(time: number, m: Matrix4): void {
    const i = this.head
    m.decompose(this.pos[i], this.quat[i], this.s)
    this.t[i] = time
    this.head = (i + 1) % HISTORY
    if (this.n < HISTORY) this.n++
  }

  /** The pose at `time` into `out`, clamped to the stored span.  False when empty. */
  sample(time: number, out: Matrix4): boolean {
    if (this.n === 0) return false
    let newer = (this.head - 1 + HISTORY) % HISTORY
    if (time >= this.t[newer]) { out.compose(this.pos[newer], this.quat[newer], ONE); return true }
    for (let k = 1; k < this.n; k++) {
      const older = (newer - 1 + HISTORY) % HISTORY
      if (time >= this.t[older]) {
        const a = (time - this.t[older]) / Math.max(1e-6, this.t[newer] - this.t[older])
        this.p.lerpVectors(this.pos[older], this.pos[newer], a)
        this.q.slerpQuaternions(this.quat[older], this.quat[newer], a)
        out.compose(this.p, this.q, ONE)
        return true
      }
      newer = older
    }
    out.compose(this.pos[newer], this.quat[newer], ONE)
    return true
  }
}

export class SeatLead {
  private prev = new Vector3()
  private havePrev = false
  private vel = new Vector3()
  private eyePrev = new Vector3()
  private haveEye = false
  private pos = new Vector3()
  private eye = new Vector3()
  private d = new Vector3()
  /** The host body's render-time lag behind the pose handed to it (s). */
  lag = 0
  speed = 0
  /** Residual between the body and the delayed visual, in frames of the measured frame time. */
  eFrames = 0
  /** Frame time (s), smoothed. */
  dtAvg = 1 / 60
  private speedAvg = 0
  /** Smoothed per-frame deviation of the aircraft's travel from steady motion (m): judder of the simulated pose itself. */
  jitter = 0
  /** Mean square of the body-vs-delayed-visual miss (m^2): see `shakeCm`. */
  private shake2 = 0
  private visOn = false
  private visBehind = 0
  private anchored = false
  private trail = 0
  private trailAvg = 0
  private trailVar = 0

  reset(): void {
    this.havePrev = false
    this.haveEye = false
    this.lag = 0
    this.speed = 0
    this.eFrames = 0
    this.speedAvg = 0
    this.jitter = 0
    this.shake2 = 0
    this.visOn = false
    this.visBehind = 0
    this.anchored = false
    this.trail = 0
    this.trailAvg = 0
    this.trailVar = 0
  }

  /**
   * Render time: how far the body really is from where the true pose would
   * have it (`trail`, m), and whether the visuals were anchored to it.  The
   * RMS of the trail's frame-to-frame wander (`trailShakeCm`) is the judder a
   * time-delayed visual cannot follow: zero for a body exactly one frame
   * late, a physics step of travel for one that moves in stairs.
   */
  reportAnchor(anchored: boolean, trail: number): void {
    this.anchored = anchored
    this.trail = trail
    if (this.speed > MIN_SPEED) {
      this.trailAvg += (trail - this.trailAvg) * 0.1
      const dev = trail - this.trailAvg
      this.trailVar += (dev * dev - this.trailVar) * 0.1
    }
    if (lastLag) { lastLag.anchored = anchored; lastLag.trailM = trail; lastLag.trailShakeCm = Math.sqrt(this.trailVar) * 100 }
  }

  /** What was handed to the eye this frame: the delayed pose (or the true one, `on` false). */
  reportVisual(on: boolean, visual: Matrix4): void {
    this.visOn = on
    this.visBehind = on ? this.d.setFromMatrixPosition(visual).distanceTo(this.pos) : 0
    if (lastLag) { lastLag.visOn = this.visOn; lastLag.visBehindM = this.visBehind }
  }

  /**
   * @param trueMatrix the aircraft (seat group) pose this frame, as simulated
   * @param refLocal the point the followed thing should be at, in that frame
   *        (the seat origin when `follower` is the body, the eye when it is the camera)
   * @param follower where the host put the body (feet) -- or, failing that,
   *        the camera -- as read at the start of this frame
   * @param active the local user sits here and flies
   */
  update(dt: number, trueMatrix: Matrix4, refLocal: [number, number, number], follower: Vector3, active: boolean): void {
    this.pos.setFromMatrixPosition(trueMatrix)
    if (this.havePrev && dt > 0) this.vel.copy(this.pos).sub(this.prev).divideScalar(dt)
    else this.vel.set(0, 0, 0)
    this.prev.copy(this.pos)
    this.havePrev = true
    if (dt > 0 && dt < 0.1) this.dtAvg += (dt - this.dtAvg) * 0.1
    this.speed = this.vel.length()
    if (this.speed > MIN_SPEED) {
      this.speedAvg += (this.speed - this.speedAvg) * 0.1
      this.jitter += (Math.abs(this.speed - this.speedAvg) * dt - this.jitter) * 0.1
    }
    this.eye.set(refLocal[0], refLocal[1], refLocal[2]).applyMatrix4(trueMatrix)
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    if (active && this.haveEye && this.speed > MIN_SPEED && hSpeed > MIN_SPEED * 0.5) {
      // Horizontal components only: the body's feet sit below the seat point.
      this.d.copy(this.eyePrev).sub(follower)
      const e = (this.d.x * this.vel.x + this.d.z * this.vel.z) / (hSpeed * hSpeed) // seconds behind last frame's point
      const target = Math.min(MAX_LAG_S, Math.max(0, e))
      this.lag += (target - this.lag) * Math.min(1, dt / SETTLE_S)
      this.eFrames = (e - this.lag) / this.dtAvg
      const miss = (e - this.lag) * hSpeed
      this.shake2 += (miss * miss - this.shake2) * 0.1
    }
    this.eyePrev.copy(this.eye)
    this.haveEye = true
    if (active) lastLag = { speed: this.speed, eFrames: this.eFrames, lagMs: this.lag * 1000, dtMs: this.dtAvg * 1000, jitterCm: this.jitter * 100, shakeCm: Math.sqrt(this.shake2) * 100, visOn: this.visOn, visBehindM: this.visBehind, anchored: this.anchored, trailM: this.trail, trailShakeCm: Math.sqrt(this.trailVar) * 100 }
  }
}
