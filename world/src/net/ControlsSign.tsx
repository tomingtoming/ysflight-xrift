/**
 * ControlsSign — how to fly, as a drawing on a board beside the kiosk.
 *
 * Four ways in (keyboard + mouse, gamepad, VR hands, phone) and none of them
 * is discoverable from inside the cockpit.  The board stands left of the
 * kiosk, turned toward the spawn point.  It shows each device with what its
 * keys, sticks and buttons do written on it (controlsDiagram.ts draws it
 * into a canvas once; here it is a texture on a plane).  Nothing on it can
 * be pressed.
 *
 * It was a table of text first (2026-11-11, same day): toming asked for a
 * picture instead.
 */
import { useEffect, useMemo } from 'react'
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three'
import { DIAGRAM_H, DIAGRAM_W, drawControlsDiagram } from './controlsDiagram'

const PX = 0.001 // metres per canvas pixel
const W_M = DIAGRAM_W * PX
const H_M = DIAGRAM_H * PX
const POST_H = 1.6 - H_M / 2 // the board's centre stands 1.6 m above the apron (World.tsx)

export function ControlsSign({ position, yaw }: { position: [number, number, number]; yaw: number }) {
  const tex = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = DIAGRAM_W
    canvas.height = DIAGRAM_H
    drawControlsDiagram(canvas.getContext('2d')!)
    const t = new CanvasTexture(canvas)
    t.colorSpace = SRGBColorSpace
    t.generateMipmaps = true
    t.minFilter = LinearMipmapLinearFilter
    t.magFilter = LinearFilter
    t.anisotropy = 8 // read at an angle from the spawn point
    return t
  }, [])
  useEffect(() => () => tex.dispose(), [tex])
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <mesh>
        <planeGeometry args={[W_M, H_M]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
      {/* a dark back, so the board is not see-through from behind */}
      <mesh rotation={[0, Math.PI, 0]} position={[0, 0, -0.005]}>
        <planeGeometry args={[W_M, H_M]} />
        <meshBasicMaterial color="#101418" toneMapped={false} />
      </mesh>
      <mesh position={[0, -H_M / 2 - POST_H / 2, -0.14]}>
        <boxGeometry args={[0.25, POST_H, 0.25]} />
        <meshStandardMaterial color="#555" />
      </mesh>
    </group>
  )
}
