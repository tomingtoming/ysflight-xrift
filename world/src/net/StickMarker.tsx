/**
 * StickBox — the stick position box at the lower left of the HUD glass, in
 * place of YSFLIGHT's virtual joystick (a 3D stick model the engine draws in
 * its own cockpit view, skipped on the external-view host).  A square frame
 * with a dot for the stick (right = roll right, up = stick forward / nose
 * down) and a bar beneath it for the rudder, read from the engine's VR
 * control block, which every stick path writes (host keys, mouse, VR hands).
 */
import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { BufferGeometry, Float32BufferAttribute, Mesh } from 'three'
import { useEngine } from '../engine/engineStore'
import { HUD_H, HUD_W } from '../engine/hudTarget'
import type { EyeOffset } from './seatEye'

const HALF = 0.07 // box half size (m)
const RUDDER_Y = -HALF - 0.025
const GREEN = 0x64ff64

export function StickMarker({ eye, distance = 1.4 }: { eye: EyeOffset; distance?: number }) {
  const mod = useEngine()
  const dot = useRef<Mesh>(null)
  const rud = useRef<Mesh>(null)
  const frame = useMemo(() => {
    const g = new BufferGeometry()
    const h = HALF, r = RUDDER_Y
    g.setAttribute('position', new Float32BufferAttribute([
      -h, -h, 0, h, -h, 0, h, -h, 0, h, h, 0, h, h, 0, -h, h, 0, -h, h, 0, -h, -h, 0, // box
      -h, 0, 0, -h + 0.01, 0, 0, h - 0.01, 0, 0, h, 0, 0, 0, h, 0, 0, h - 0.01, 0, 0, -h, 0, 0, -h + 0.01, 0, // centre ticks
      -h, r, 0, h, r, 0, // rudder bar
    ], 3))
    return g
  }, [])
  useFrame(() => {
    if (!mod) return
    const c = mod._FsVrControlDataPointer() >> 2
    const f = mod.HEAPF32
    dot.current?.position.set(f[c + 1] * HALF, -f[c + 2] * HALF, 0.001)
    rud.current?.position.set(-f[c + 3] * HALF, RUDDER_Y, 0.001) // rudder + = nose left -> tick left
  })
  // Lower-left corner of the glass (HudGlass.tsx: width 0.9 x distance, HUD aspect), inset by the box.
  const w = 2 * 0.45 * distance
  const h = (w * HUD_H) / HUD_W
  const pos: [number, number, number] = [-w / 2 + HALF + 0.04, eye.dy - h / 2 + HALF + 0.06, eye.dz - distance + 0.01]
  return (
    <group position={pos} renderOrder={1003}>
      <lineSegments geometry={frame} renderOrder={1003} frustumCulled={false}>
        <lineBasicMaterial color={GREEN} transparent opacity={0.7} depthTest={false} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <mesh ref={dot} renderOrder={1004} frustumCulled={false}>
        <circleGeometry args={[0.008, 16]} />
        <meshBasicMaterial color={GREEN} depthTest={false} depthWrite={false} toneMapped={false} />
      </mesh>
      <mesh ref={rud} renderOrder={1004} frustumCulled={false}>
        <planeGeometry args={[0.006, 0.02]} />
        <meshBasicMaterial color={GREEN} depthTest={false} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  )
}
