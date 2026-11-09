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
 *    in frames of the measured frame time: the number the tests watch.
 */
import { Matrix4, Quaternion, Vector3 } from 'three'

const MIN_SPEED = 20 // m/s: below this the measurement is noise (head motion, taxiing)
const MAX_LAG_S = 0.15
const SETTLE_S = 0.5
const HISTORY = 16
const ONE = new Vector3(1, 1, 1)

export interface LagReport { speed: number; eFrames: number; lagMs: number; dtMs: number; jitterCm: number }
let lastLag: LagReport | null = null
/** The seated local user's lag measurement, for the beacon. */
export function seatLag(): LagReport | null { return lastLag }
export function clearSeatLag(): void { lastLag = null }

/** The host's local body (feet) position, if the platform exposes it (array or {x,y,z}). */
export function readFeet(users: unknown, out: Vector3): Vector3 | null {
  try {
    const u = users as { getLocalMovement?: () => { position?: unknown } | null }
    const p = u.getLocalMovement?.()?.position as unknown
    if (Array.isArray(p)) return out.set(p[0], p[1], p[2])
    if (p && typeof p === 'object') { const o = p as { x: number; y: number; z: number }; return out.set(o.x, o.y, o.z) }
  } catch { /* no movement API */ }
  return null
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

  reset(): void {
    this.havePrev = false
    this.haveEye = false
    this.lag = 0
    this.speed = 0
    this.eFrames = 0
    this.speedAvg = 0
    this.jitter = 0
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
    }
    this.eyePrev.copy(this.eye)
    this.haveEye = true
    if (active) lastLag = { speed: this.speed, eFrames: this.eFrames, lagMs: this.lag * 1000, dtMs: this.dtAvg * 1000, jitterCm: this.jitter * 100 }
  }
}
