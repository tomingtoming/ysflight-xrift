/**
 * TouchConsole — the phone pilot's switches.
 *
 * A phone gives the seated player two stick axes, an interact tap and a
 * jump (leave); there is no key for throttle, afterburner, gear, brake,
 * flaps or the gun.  This panel sits below the HUD glass, tilted up to the
 * eye, with one button per function.  Look at a button (the crosshair is
 * the camera ray) and tap インタラクト: the host turns that into a uikit
 * click.  Shown on coarse-pointer devices only, never inside an XR session
 * (VR flies by the hands, see vr/saccControls.ts; desktop has the keys).
 *
 * THR−/THR＋ write the engine's VR throttle block in 10 % steps (the block
 * is authoritative once touched, like a lever that stays where it is left);
 * the rest tap the engine's default keys.  FIRE holds the gun key for half
 * a second per tap.  Each button shows the live state from the flight data.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame, useThree } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useCallback, useMemo, useRef, useState } from 'react'
import { Group, Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import type { EyeOffset } from './seatEye'
import { publishConsole } from './StateBeacon'

const PX = 0.001
const BTN_W = 108
const BTN_H = 78
const GAP = 18
const PAD = 20
const N = 8
const COLS = 4 // two rows of four: a portrait phone shows the whole panel
const ROWS = N / COLS
const W = PAD * 2 + BTN_W * COLS + GAP * (COLS - 1)
const H = PAD * 2 + BTN_H * ROWS + GAP * (ROWS - 1)
const C_THR_GRABBED = 4, C_THR = 5, C_THR_EVER = 6
const FIRE_FRAMES = 30

type Act = 'thr-' | 'thr+' | 'Tab' | 'KeyG' | 'KeyB' | 'KeyF' | 'KeyR' | 'fire'
const BUTTONS: Array<{ id: string; label: string; act: Act }> = [
  { id: 'thr-', label: 'THR -', act: 'thr-' },
  { id: 'thr+', label: 'THR +', act: 'thr+' },
  { id: 'ab', label: 'A/B', act: 'Tab' },
  { id: 'gear', label: 'GEAR', act: 'KeyG' },
  { id: 'brk', label: 'BRK', act: 'KeyB' },
  { id: 'flap-', label: 'FLP DN', act: 'KeyF' },
  { id: 'flap+', label: 'FLP UP', act: 'KeyR' },
  { id: 'fire', label: 'FIRE', act: 'fire' },
]

export function isCoarsePointer(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches } catch { return false }
}

export function TouchConsole({ eye }: { eye: EyeOffset }) {
  const mod = useEngine()
  const gl = useThree((s) => s.gl)
  const fontFamilies = useDefaultFont(['ja'])
  const group = useRef<Group>(null)
  const [state, setState] = useState<string[]>(BUTTONS.map(() => ''))
  const acc = useRef(0)
  const fireLeft = useRef(0)
  // Key taps release on the next frame: the engine's button functions see
  // key *state* edges per simulation step, so a same-tick down+up is invisible.
  const pendingUp = useRef<string[]>([])
  const tmp = useRef(new Vector3())
  const positions = useRef(BUTTONS.map((b) => ({ id: `console-${b.id}`, pos: [0, 0, 0] as number[] })))

  const key = useCallback((code: string, down: boolean) => {
    mod?.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, down ? 1 : 0])
  }, [mod])

  const press = useCallback((act: Act) => {
    if (!mod) return
    const f = mod.HEAPF32
    if (act === 'thr-' || act === 'thr+') {
      const c = mod._FsVrControlDataPointer() >> 2
      const d = mod._FsVrFlightDataPointer() >> 2
      const cur = f[c + C_THR_EVER] > 0.5 ? f[c + C_THR] : f[d + 7]
      const v = Math.min(1, Math.max(0, Math.round((cur + (act === 'thr+' ? 0.1 : -0.1)) * 10) / 10))
      f[c + C_THR] = v
      f[c + C_THR_EVER] = 1
      f[c + C_THR_GRABBED] = 0
      return
    }
    if (act === 'fire') {
      key('Space', true)
      fireLeft.current = FIRE_FRAMES
      return
    }
    key(act, true)
    pendingUp.current.push(act)
  }, [mod, key])

  useFrame((_s, dt) => {
    const g = group.current
    if (!g) return
    g.visible = !gl.xr?.isPresenting
    for (const code of pendingUp.current) key(code, false)
    pendingUp.current.length = 0
    if (fireLeft.current > 0 && --fireLeft.current === 0) key('Space', false)
    acc.current += dt
    if (acc.current < 0.2) return
    acc.current = 0
    // button centres in world, for the harness
    for (let i = 0; i < N; i++) {
      const col = i % COLS, row = Math.floor(i / COLS)
      const x = (-W / 2 + PAD + BTN_W / 2 + col * (BTN_W + GAP)) * PX
      const y = (H / 2 - PAD - BTN_H / 2 - row * (BTN_H + GAP)) * PX
      tmp.current.set(x, y, 0).applyMatrix4(g.matrixWorld)
      positions.current[i].pos = tmp.current.toArray()
    }
    publishConsole(g.visible ? positions.current : null)
    if (!mod) return
    const f = mod.HEAPF32
    const d = mod._FsVrFlightDataPointer() >> 2
    const thr = `${Math.round(f[d + 7] * 100)}%`
    const next = [thr, thr, f[d + 8] > 0.5 ? 'ON' : 'off', f[d + 9] > 0.5 ? 'DOWN' : 'UP', f[d + 10] > 0.5 ? 'ON' : 'off', `${Math.round(f[d + 11] * 100)}%`, `${Math.round(f[d + 11] * 100)}%`, fireLeft.current > 0 ? '●' : '']
    if (next.some((v, i) => v !== state[i])) setState(next)
  })

  const tilt = useMemo(() => -Math.atan2(0.42, 1.1), [])
  return (
    <group ref={group} position={[0, eye.dy - 0.42, eye.dz - 1.1]} rotation={[tilt, 0, 0]}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={16} padding={PAD}
        flexDirection="column" gap={GAP} fontFamilies={fontFamilies}>
        {Array.from({ length: ROWS }, (_, r) => (
          <Container key={r} flexDirection="row" gap={GAP}>
            {BUTTONS.slice(r * COLS, (r + 1) * COLS).map((b, c) => {
              const i = r * COLS + c
              return (
                <Container key={b.id} width={BTN_W} height={BTN_H} borderRadius={10} justifyContent="center" alignItems="center" flexDirection="column"
                  backgroundColor={0x2a3340} hover={{ backgroundColor: 0x3d4a5c }} cursor="pointer" onClick={() => press(b.act)}>
                  <Text fontSize={26} color={0xffffff}>{b.label}</Text>
                  <Text fontSize={20} color={0x9fd0ff}>{state[i] || ' '}</Text>
                </Container>
              )
            })}
          </Container>
        ))}
      </Container>
    </group>
  )
}
