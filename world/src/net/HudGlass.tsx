/**
 * HudGlass — the engine's real flat HUD on a cockpit-anchored glass.
 *
 * The engine renders its in-flight HUD into an off-screen texture every
 * draw (engine/hudTarget.ts); this plane shows it 1.4 m ahead of the eye,
 * sized so the symbology subtends the same angle as the engine's own VR
 * glass (0.45 m half-width at 1 m).  Drawn over the scene regardless of
 * depth, like the engine does.
 */
import { DoubleSide } from 'three'
import { useHudTexture } from '../engine/engineStore'
import { HUD_H, HUD_W } from '../engine/hudTarget'

export interface HudGlassProps {
  position?: [number, number, number]
}

export function HudGlass({ position = [0, 0.67, -1.4] }: HudGlassProps) {
  const texture = useHudTexture()
  if (!texture) return null
  const dist = Math.hypot(position[0], position[1] - 0.67, position[2]) || 1.4
  const w = 2 * 0.45 * dist
  const h = (w * HUD_H) / HUD_W
  return (
    <mesh position={position} renderOrder={1000}>
      <planeGeometry args={[w, h]} />
      <meshBasicMaterial map={texture} transparent depthTest={false} depthWrite={false} toneMapped={false} side={DoubleSide} />
    </mesh>
  )
}
