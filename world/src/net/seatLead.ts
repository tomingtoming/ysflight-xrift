/**
 * seatLead — keep the seated camera on the moving cockpit.
 *
 * The host reads a seat's surface in its own frame callbacks and, in VR,
 * moves the player through a kinematic body that the physics step applies
 * a frame later.  Each frame of pipeline delay puts the eye one frame of
 * travel behind the cockpit: 5 m at 300 m/s, which is what a pilot saw with
 * the afterburner lit ("the view and the avatar could not keep up").
 *
 * Two measures.  The seats update at a priority ahead of the host's
 * callbacks (engine step -3, seats -2, host camera -1, host body 0) and
 * refresh their matrixWorld on the spot, so the host reads this frame's
 * pose.  Whatever delay remains is measured here on the host's BODY (the
 * avatar's feet; the camera where no body position is exposed): the body
 * read at the start of our callback shows where the host put it for the
 * previous frame; its distance along the velocity from the previous
 * frame's seat point, divided by the speed, is the residual delay.  The
 * whole seat pose handed to the host -- and the HUD, gunsight and hands
 * with it -- is led by velocity x delay, so the avatar sits in the cockpit
 * (a third-person pilot stood 3 m behind it at 350 kt before, 2026-11-09)
 * and the first-person camera agrees with the HUD glass.  The engine's
 * own drawing is then one frame behind the eye: unnoticeable, since the
 * cockpit view hides the pilot's own aircraft.  Converges within a
 * second, holds its value at low speed.
 */
import { Matrix4, Vector3 } from 'three'

const MIN_SPEED = 20 // m/s: below this the measurement is noise (head motion, taxiing)
const MAX_LEAD_S = 0.15
const SETTLE_S = 0.5

export interface LagReport { speed: number; eFrames: number; leadMs: number }
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

export class SeatLead {
  private prev = new Vector3()
  private havePrev = false
  private vel = new Vector3()
  private eyePrev = new Vector3()
  private haveEye = false
  private pos = new Vector3()
  private eye = new Vector3()
  private d = new Vector3()
  /** Residual pipeline delay (s) the seat surface is led by. */
  lead = 0
  speed = 0
  /** Last measured camera lag along the velocity, in frames at 60 Hz (before the lead applied). */
  eFrames = 0

  reset(): void {
    this.havePrev = false
    this.haveEye = false
    this.lead = 0
    this.speed = 0
    this.eFrames = 0
  }

  /**
   * @param trueMatrix the aircraft (seat group) pose this frame
   * @param refLocal the point the followed thing should be at, in that frame
   *        (the seat origin when `follower` is the body, the eye when it is the camera)
   * @param follower where the host put the body (feet) -- or, failing that,
   *        the camera -- as read at the start of this frame.  The body is
   *        what lags on every platform (kinematic physics, one step late);
   *        measuring it keeps a third-person avatar in the cockpit too.
   * @param active the local user sits here and flies
   * @param out receives the world-space lead to add to the pose
   */
  update(dt: number, trueMatrix: Matrix4, refLocal: [number, number, number], follower: Vector3, active: boolean, out: Vector3): Vector3 {
    this.pos.setFromMatrixPosition(trueMatrix)
    if (this.havePrev && dt > 0) this.vel.copy(this.pos).sub(this.prev).divideScalar(dt)
    else this.vel.set(0, 0, 0)
    this.prev.copy(this.pos)
    this.havePrev = true
    this.speed = this.vel.length()
    this.eye.set(refLocal[0], refLocal[1], refLocal[2]).applyMatrix4(trueMatrix)
    const hSpeed = Math.hypot(this.vel.x, this.vel.z)
    if (active && this.haveEye && this.speed > MIN_SPEED && hSpeed > MIN_SPEED * 0.5) {
      // Horizontal components only: the body's feet sit below the seat point.
      this.d.copy(this.eyePrev).sub(follower)
      const e = (this.d.x * this.vel.x + this.d.z * this.vel.z) / (hSpeed * hSpeed) // seconds behind
      const delay = Math.min(MAX_LEAD_S, Math.max(0, e + this.lead))
      this.lead += (delay - this.lead) * Math.min(1, dt / SETTLE_S)
      this.eFrames = e * 60
    }
    this.eyePrev.copy(this.eye)
    this.haveEye = true
    if (active) lastLag = { speed: this.speed, eFrames: this.eFrames, leadMs: this.lead * 1000 }
    return out.copy(this.vel).multiplyScalar(active ? this.lead : 0)
  }
}
