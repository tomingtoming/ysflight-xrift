/**
 * SaccHands — runs the SaccFlight-style controls (saccControls.ts) while the
 * local pilot sits in a flying aircraft inside an immersive session, and
 * shows each hand's function dial as a small placard above the controller
 * while its thumbstick is deflected.
 *
 * Hand poses come from the XRSession in reference space; world placement
 * is camWorld * inverse(viewerPose) * gripPose, so the placards ride with
 * the host's rig (which follows the seat) without touching host internals.
 */
import { createPortal, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { CanvasTexture, Group, Matrix4, Quaternion, Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { CTL, controlBus } from '../engine/controlBus'
import { LEFT_DIAL, RIGHT_DIAL, SaccControls, saccStatus, type DialEntry } from './saccControls'
import { makeXrSample, sampleXr, type Hand } from './xrHands'

const DIAL_PX = 256
const DIAL_SIZE_M = 0.16
const DIAL_LIFT_M = 0.12

function drawDial(ctx: CanvasRenderingContext2D, table: DialEntry[], sel: number | null): void {
  const n = table.length
  const cx = DIAL_PX / 2, cy = DIAL_PX / 2
  ctx.clearRect(0, 0, DIAL_PX, DIAL_PX)
  // dark backdrop: the placard is read against sky and cloud as often as cockpit
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.beginPath()
  ctx.arc(cx, cy, DIAL_PX / 2 - 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineCap = 'round'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n // clockwise from up
    const dx = Math.sin(a), dy = -Math.cos(a)
    const on = i === sel
    ctx.strokeStyle = on ? '#ffb347' : 'rgba(255,255,255,0.85)'
    ctx.lineWidth = on ? 6 : 3
    ctx.beginPath()
    ctx.moveTo(cx + dx * 34, cy + dy * 34)
    ctx.lineTo(cx + dx * (on ? 62 : 52), cy + dy * (on ? 62 : 52))
    ctx.stroke()
    ctx.fillStyle = on ? '#ffb347' : 'rgba(255,255,255,0.9)'
    ctx.font = `${on ? 'bold ' : ''}${on ? 26 : 22}px sans-serif`
    const lr = 92
    ctx.fillText(table[i].label, cx + dx * lr, cy + dy * lr)
  }
  if (sel !== null) {
    ctx.fillStyle = '#ffb347'
    ctx.beginPath()
    ctx.arc(cx, cy, 6, 0, Math.PI * 2)
    ctx.fill()
  }
}

function useDialTexture(): { tex: CanvasTexture; ctx: CanvasRenderingContext2D; drawn: { sel: number | null; init: boolean } } {
  return useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = DIAL_PX
    canvas.height = DIAL_PX
    const ctx = canvas.getContext('2d')!
    const tex = new CanvasTexture(canvas)
    return { tex, ctx, drawn: { sel: null, init: false } }
  }, [])
}

export function SaccHands() {
  const mod = useEngine()
  const scene = useThree((s) => s.scene)
  const sample = useRef(makeXrSample())
  const ctl = useRef<SaccControls | null>(null)
  const modRef = useRef(mod)
  modRef.current = mod
  const groups: Record<Hand, React.RefObject<Group | null>> = { left: useRef<Group>(null), right: useRef<Group>(null) }
  const dials: Record<Hand, ReturnType<typeof useDialTexture>> = { left: useDialTexture(), right: useDialTexture() }
  const one = useRef(new Vector3(1, 1, 1))
  const rig = useRef(new Matrix4())
  const pos = useRef(new Vector3())
  const up = useRef(new Vector3())
  const camPos = useRef(new Vector3())
  const look = useRef(new Matrix4())
  const q = useRef(new Quaternion())

  if (!ctl.current && mod) {
    const md = mod
    ctl.current = new SaccControls({
      edge: (code, down) => { md.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, down ? 1 : 0]) },
    })
  }

  // saccControls writes a control-block image of its own; what it holds is
  // then claimed on the bus (engine/controlBus.ts), the one writer of the real block.
  const image = useRef(new Float32Array(16))
  useEffect(() => () => {
    ctl.current?.detach(image.current, 0)
    controlBus.releaseYawAndThrottle()
  }, [])

  useFrame((state, _dt, frame) => {
    const md = mod
    const sc = ctl.current
    if (!md || !sc) return
    const s = sampleXr(state, frame as XRFrame | undefined, sample.current)
    const f = image.current
    const c = 0
    if (!s.presenting) {
      if (sc.engaged) { sc.detach(f, c); controlBus.releaseYawAndThrottle() }
      groups.left.current && (groups.left.current.visible = false)
      groups.right.current && (groups.right.current.visible = false)
      return
    }
    sc.update(s, f, c, performance.now())
    if (f[CTL.STICK_HELD] > 0.5) controlBus.stick('vr', f[CTL.AIL], f[CTL.ELV], f[CTL.RUD])
    if (f[CTL.THR_HELD] > 0.5) controlBus.throttle(f[CTL.THR], true)
    if (f[CTL.CONFIRM] > 0.5) controlBus.confirm()

    const cam = state.gl.xr.getCamera()
    rig.current.copy(cam.matrixWorld).multiply(s.viewerInv) // reference space -> world
    camPos.current.setFromMatrixPosition(cam.matrixWorld)
    up.current.set(0, 1, 0).transformDirection(rig.current)
    for (const hand of ['left', 'right'] as Hand[]) {
      const g = groups[hand].current
      if (!g) continue
      const h = s.hands[hand]
      const d = sc.dial[hand]
      if (!h.tracked || !d.visible) { g.visible = false; continue }
      const dial = dials[hand]
      if (!dial.drawn.init || dial.drawn.sel !== d.sel) {
        drawDial(dial.ctx, hand === 'right' ? RIGHT_DIAL : LEFT_DIAL, d.sel)
        dial.tex.needsUpdate = true
        dial.drawn.init = true
        dial.drawn.sel = d.sel
      }
      pos.current.copy(h.pos).applyMatrix4(rig.current).addScaledVector(up.current, DIAL_LIFT_M)
      look.current.lookAt(camPos.current, pos.current, up.current) // plane +Z toward the eye
      q.current.setFromRotationMatrix(look.current)
      g.matrixAutoUpdate = false
      g.matrix.compose(pos.current, q.current, one.current)
      g.matrixWorldNeedsUpdate = true
      g.visible = true
      saccStatus[hand].pos = pos.current.toArray()
    }
  })

  return createPortal(
    <>
      {(['left', 'right'] as Hand[]).map((hand) => (
        <group key={hand} ref={groups[hand]} visible={false}>
          <mesh renderOrder={1002} frustumCulled={false}>
            <planeGeometry args={[DIAL_SIZE_M, DIAL_SIZE_M]} />
            <meshBasicMaterial map={dials[hand].tex} transparent depthTest={false} depthWrite={false} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </>,
    scene,
  )
}
