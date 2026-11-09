/**
 * seatEye — put the pilot's eye where the engine's cockpit point is.
 *
 * The host seats an avatar by its hip (the <Seat> origin); how far above
 * that the eye ends up depends on the avatar (1.05 m vs 1.60 m eye heights
 * seen in production) and, in VR, on the player's real head.  Instead of a
 * fixed hip-to-eye drop the seat measures the camera relative to its own
 * origin once the host has settled the avatar (1.0 s after sitting, 0.5 s
 * average) and moves its origin so the eye lands on the cockpit point.
 * The measurement is in the seat group's frame, so it works parked on a
 * pedestal or in a parked aircraft alike; the residual keeps being
 * measured afterwards for the beacon.
 */
import { Matrix4, Vector3 } from 'three'

export interface EyeOffset {
  /** Eye above the seat origin (m). */
  dy: number
  /** Eye ahead (-) / behind (+) the seat origin (m), seat frame. */
  dz: number
}

/** Hip-to-eye for a 1.6 m avatar: the value used before measuring. */
export const DEFAULT_EYE: EyeOffset = { dy: 0.72, dz: 0 }

const SETTLE_S = 1.0
const SAMPLE_S = 0.5

export interface EyeReport { dx: number; dy: number; dz: number; n: number; res: number[] }
let lastEye: EyeReport | null = null
/** The last measurement (for the beacon). */
export function eyeCalibration(): EyeReport | null { return lastEye }

export class EyeCalibrator {
  private t = 0
  private n = 0
  private sum = new Vector3()
  private done = false
  private inv = new Matrix4()
  private p = new Vector3()
  private applied: EyeOffset = { ...DEFAULT_EYE }

  reset(): void {
    this.t = 0
    this.n = 0
    this.sum.set(0, 0, 0)
    this.done = false
  }

  /**
   * Call every frame while the local user sits.  Returns the offset to
   * apply exactly once per sit, once the measurement completes.
   */
  tick(dt: number, camWorld: Matrix4, groupWorld: Matrix4, seatLocal: [number, number, number], current: EyeOffset): EyeOffset | null {
    this.t += dt
    if (this.t < SETTLE_S) return null
    this.inv.copy(groupWorld).invert()
    this.p.setFromMatrixPosition(camWorld).applyMatrix4(this.inv)
    this.p.x -= seatLocal[0]
    this.p.y -= seatLocal[1]
    this.p.z -= seatLocal[2]
    if (this.done) {
      if (lastEye) lastEye.res = [this.p.x, this.p.y - this.applied.dy, this.p.z - this.applied.dz]
      return null
    }
    this.sum.add(this.p)
    this.n++
    if (this.t < SETTLE_S + SAMPLE_S) return null
    this.done = true
    const dx = this.sum.x / this.n
    const dy = Math.min(1.3, Math.max(0.3, this.sum.y / this.n))
    const dz = Math.min(0.4, Math.max(-0.4, this.sum.z / this.n))
    this.applied = { dy, dz }
    lastEye = { dx, dy, dz, n: this.n, res: [0, 0, 0] }
    if (Math.abs(dy - current.dy) < 0.005 && Math.abs(dz - current.dz) < 0.005) return null
    return this.applied
  }
}
