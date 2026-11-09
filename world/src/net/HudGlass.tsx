/**
 * HudGlass — the engine's real flat HUD on a cockpit-anchored glass.
 *
 * The engine renders its in-flight HUD into an off-screen texture every
 * draw (engine/hudTarget.ts); this plane shows it 1.4 m ahead of the eye,
 * sized so the symbology subtends the same angle as the engine's own VR
 * glass (0.45 m half-width at 1 m).  Drawn over the scene regardless of
 * depth, like the engine does.
 */
import { useMemo } from 'react'
import { BufferGeometry, DoubleSide, Float32BufferAttribute } from 'three'
import { useHudTexture } from '../engine/engineStore'
import { HUD_H, HUD_W } from '../engine/hudTarget'
import type { EyeOffset } from './seatEye'

/**
 * Gunsight — the gun crosshair the engine would bake into the flat HUD,
 * drawn instead as world-space lines far along the boresight (the engine's
 * own VR path does the same at 2000 m; FsVrHudDataPointer()[6] turns the
 * baked one off).  On a glass 1.4 m away the pipper swims with the head;
 * at 800 m (inside the host camera's 1000 m far plane) a 64 mm head
 * movement shifts it by an invisible angle.  Proportions follow
 * FsHeadUpDisplay::DrawCrossHair: vertical arms 2/3 of the horizontal
 * ones, 4 px centre gap against a hudWid/20 arm; colour HUD green.
 */
export function Gunsight({ eye }: { eye: EyeOffset }) {
  const geometry = useMemo(() => {
    const D = 800
    // Arm length 1.2 deg: what the baked cross subtended on the 1.4 m glass
    // (hudWid/20 of a 1.26 m wide HUD), so the pipper keeps its familiar size.
    const half = D * Math.tan((1.2 * Math.PI) / 180)
    const vHalf = (half * 2) / 3
    const gap = half * (4 / (384 / 20))
    const y = eye.dy, z = eye.dz - D
    const v = [
      -half, y, z, -gap, y, z,
      gap, y, z, half, y, z,
      0, y - vHalf, z, 0, y - gap, z,
      0, y + gap, z, 0, y + vHalf, z,
    ]
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(v, 3))
    return g
  }, [eye.dy, eye.dz])
  return (
    <lineSegments geometry={geometry} renderOrder={1001} frustumCulled={false}>
      <lineBasicMaterial color={0x64ff64} depthTest={false} depthWrite={false} toneMapped={false} />
    </lineSegments>
  )
}

export interface HudGlassProps {
  /** Where the pilot's eye is in the seat frame (seatEye.ts). */
  eye: EyeOffset
  /** Glass distance ahead of the eye (m). */
  distance?: number
}

export function HudGlass({ eye, distance = 1.4 }: HudGlassProps) {
  const texture = useHudTexture()
  if (!texture) return null
  const position: [number, number, number] = [0, eye.dy, eye.dz - distance]
  const dist = distance
  const w = 2 * 0.45 * dist
  const h = (w * HUD_H) / HUD_W
  return (
    <mesh position={position} renderOrder={1000}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} toneMapped={false} side={DoubleSide} />
    </mesh>
  )
}
