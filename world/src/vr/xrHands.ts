/**
 * xrHands — one frame of WebXR controller state, read straight from the
 * XRSession the host runs (no dependency on the host's XR components).
 *
 * Poses are in the session's reference space (room-fixed); the player rig
 * is applied by the caller through the XR camera (camWorld * viewerInv).
 * Buttons follow the xr-standard gamepad mapping: [0] trigger, [1] squeeze,
 * [3] thumbstick click, [4] A/X, [5] B/Y; axes [2],[3] thumbstick.
 */
import type { RootState } from '@react-three/fiber'
import { Matrix4, Quaternion, Vector3 } from 'three'

export type Hand = 'left' | 'right'

export interface HandSample {
  /** A grip pose was reported this frame. */
  tracked: boolean
  pos: Vector3
  quat: Quaternion
  squeeze: number
  trigger: number
  /** Thumbstick x (right +) and y (toward the user +), xr-standard. */
  thumb: [number, number]
  a: boolean
  b: boolean
  gamepad: Gamepad | null
}

export interface XrSample {
  presenting: boolean
  viewerPos: Vector3
  viewerQuat: Quaternion
  /** Inverse of the viewer pose (reference space -> viewer space). */
  viewerInv: Matrix4
  hands: Record<Hand, HandSample>
}

function makeHand(): HandSample {
  return { tracked: false, pos: new Vector3(), quat: new Quaternion(), squeeze: 0, trigger: 0, thumb: [0, 0], a: false, b: false, gamepad: null }
}

export function makeXrSample(): XrSample {
  return { presenting: false, viewerPos: new Vector3(), viewerQuat: new Quaternion(), viewerInv: new Matrix4(), hands: { left: makeHand(), right: makeHand() } }
}

export function sampleXr(state: RootState, frame: XRFrame | undefined, out: XrSample): XrSample {
  out.presenting = false
  out.hands.left.tracked = false
  out.hands.right.tracked = false
  const xr = state.gl.xr
  if (!xr?.isPresenting || !frame) return out
  const session = xr.getSession()
  const ref = xr.getReferenceSpace()
  if (!session || !ref) return out
  const vp = frame.getViewerPose(ref)
  if (!vp) return out
  const vt = vp.transform
  out.viewerPos.set(vt.position.x, vt.position.y, vt.position.z)
  out.viewerQuat.set(vt.orientation.x, vt.orientation.y, vt.orientation.z, vt.orientation.w)
  out.viewerInv.fromArray(vt.inverse.matrix)
  out.presenting = true
  for (const src of session.inputSources) {
    const h = src.handedness
    if (h !== 'left' && h !== 'right') continue
    const hs = out.hands[h]
    const gp = src.gamepad ?? null
    hs.gamepad = gp
    if (gp) {
      hs.squeeze = gp.buttons[1]?.value ?? 0
      hs.trigger = gp.buttons[0]?.value ?? 0
      hs.thumb[0] = gp.axes[2] ?? 0
      hs.thumb[1] = gp.axes[3] ?? 0
      hs.a = !!gp.buttons[4]?.pressed
      hs.b = !!gp.buttons[5]?.pressed
    } else {
      hs.squeeze = 0; hs.trigger = 0; hs.thumb[0] = 0; hs.thumb[1] = 0; hs.a = false; hs.b = false
    }
    if (src.gripSpace) {
      const p = frame.getPose(src.gripSpace, ref)
      if (p) {
        hs.tracked = true
        hs.pos.set(p.transform.position.x, p.transform.position.y, p.transform.position.z)
        hs.quat.set(p.transform.orientation.x, p.transform.orientation.y, p.transform.orientation.z, p.transform.orientation.w)
      }
    }
  }
  return out
}
