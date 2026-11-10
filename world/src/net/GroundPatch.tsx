/**
 * GroundPatch — something to stand on wherever the visitor is.
 *
 * The apron has its own floor (World.tsx); away from it there was nothing.
 * A pilot who left the seat on a carrier deck 38 km out fell 30 m into the
 * sea and through it ("the avatar cannot stand on the carrier deck", toming,
 * 2026-11-09).  The engine knows the surface: its ground probe answers the
 * field elevation under a point, or the flight deck of a live carrier above
 * it (fsvr.h FsVrGroundProbeDataPointer).  So one small floor follows the
 * local player, at the height the engine answers for the spot under their
 * feet.  It moves in grid steps, not continuously, so it never drags anyone
 * along; past the edge of a deck the answer is the sea again and the floor
 * drops away, as it should.
 *
 * A FIXED body that is teleported, never a kinematic one that is moved: a
 * kinematic body's move is a velocity, and its first move up from the
 * parking depth threw every visitor on the production host ten kilometres
 * into the sky (v54, 2026-11-10; the dev player did not mind).
 *
 * The probe is one point per engine step: this component owns it except
 * while the airfield measures the apron elevation (StateBeacon probeBusy).
 */
import { useFrame, useThree } from '@react-three/fiber'
import { CuboidCollider, RigidBody, type RapierRigidBody } from '@react-three/rapier'
import { useUsers } from '@xrift/world-components'
import { useRef } from 'react'
import { Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { readFeet } from './seatLead'
import { isProbeBusy, publishGround } from './StateBeacon'

const HALF = 8 // m, half the floor's side
const GRID = 4 // m, the floor's centre snaps to this grid
const THICK = 0.5 // m, half thickness

export function GroundPatch() {
  const mod = useEngine()
  const users = useUsers()
  const camera = useThree((s) => s.camera)
  const rb = useRef<RapierRigidBody>(null)
  const asked = useRef<{ x: number; z: number } | null>(null)
  const placed = useRef({ x: NaN, y: NaN, z: NaN })
  const v = useRef(new Vector3())
  useFrame(() => {
    if (!mod || isProbeBusy()) { asked.current = null; return }
    const f = mod.HEAPF32
    const gp = mod._FsVrGroundProbeDataPointer() >> 2
    const a = asked.current
    // The answer in the block belongs to the point written before the last engine step.
    if (a && f[gp + 3] !== 0 && f[gp] === a.x && f[gp + 1] === a.z) {
      const h = f[gp + 2]
      const cx = Math.round(a.x / GRID) * GRID, cz = Math.round(a.z / GRID) * GRID
      const p = placed.current
      if (cx !== p.x || cz !== p.z || Math.abs(h - p.y) > 0.01) {
        p.x = cx; p.y = h; p.z = cz
        rb.current?.setTranslation({ x: cx, y: h - THICK, z: cz }, true)
      }
      publishGround({ height: h, deck: f[gp + 4] !== 0 })
    }
    const feet = readFeet(users, v.current) ?? camera.position
    const x = Math.fround(feet.x), z = Math.fround(feet.z)
    f[gp] = x
    f[gp + 1] = z
    asked.current = { x, z }
  })
  return (
    <RigidBody ref={rb} type="fixed" position={[0, -10000, 0]} colliders={false} restitution={0} friction={0}>
      <CuboidCollider args={[HALF, THICK, HALF]} />
    </RigidBody>
  )
}
