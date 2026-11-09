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
 * pose.  Whatever delay remains is measured here: the camera read at the
 * start of our callback shows where the host put it for the previous
 * frame; its distance along the velocity from the previous frame's eye
 * point, divided by the speed, is the residual delay.  The seat surface
 * handed to the host is then led by velocity x delay (position only; the
 * cockpit-anchored HUD stays on the true pose), so the camera lands on
 * the cockpit.  Converges within a second, holds its value at low speed.
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
   * @param eyeLocal the pilot's eye in that frame
   * @param cam the camera's world position as read at the start of this frame
   * @param active the local user sits here and flies
   * @param out receives the world-space lead to add to the seat surface
   */
  update(dt: number, trueMatrix: Matrix4, eyeLocal: [number, number, number], cam: Vector3, active: boolean, out: Vector3): Vector3 {
    this.pos.setFromMatrixPosition(trueMatrix)
    if (this.havePrev && dt > 0) this.vel.copy(this.pos).sub(this.prev).divideScalar(dt)
    else this.vel.set(0, 0, 0)
    this.prev.copy(this.pos)
    this.havePrev = true
    this.speed = this.vel.length()
    this.eye.set(eyeLocal[0], eyeLocal[1], eyeLocal[2]).applyMatrix4(trueMatrix)
    if (active && this.haveEye && this.speed > MIN_SPEED) {
      const e = this.d.copy(this.eyePrev).sub(cam).dot(this.vel) / (this.speed * this.speed) // seconds behind
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
