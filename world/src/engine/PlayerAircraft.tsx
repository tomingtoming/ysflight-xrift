/**
 * PlayerAircraft — a three.js group that follows the engine's player
 * aircraft (fsvr player-pose block) and carries an XRift <Seat> at the
 * cockpit, so the avatar sits in the aircraft the engine is flying.
 *
 * The engine draws the aircraft itself; this group only carries the seat
 * (and, in dev, a small marker).  While the local user is seated the engine
 * is switched to cockpit view (own exterior hidden, F1) and back to the
 * outside view on exit (F2).
 */
import { useFrame } from '@react-three/fiber'
import { Seat } from '@xrift/world-components'
import { useCallback, useRef, useState } from 'react'
import { Group } from 'three'
import { useEngine } from './engineStore'

interface SeatOccupant {
  id: string
  isLocalUser: boolean
}

export interface PlayerAircraftProps {
  /** Show a marker at the seat (dev aid). */
  marker?: boolean
  /** Mount the XRift Seat (default true); false = follow-only group. */
  seat?: boolean
}

export function PlayerAircraft({ marker = false, seat = true }: PlayerAircraftProps) {
  const mod = useEngine()
  const group = useRef<Group>(null)
  const [valid, setValid] = useState(false)
  const [cockpit, setCockpit] = useState<[number, number, number]>([0, 1, 0])
  const cockpitRef = useRef(cockpit)

  useFrame(() => {
    const g = group.current
    if (!mod || !g) return
    const p = mod._FsVrPlayerPoseDataPointer() >> 2
    const f = mod.HEAPF32
    const v = f[p] !== 0
    if (v !== valid) setValid(v)
    if (!v) return
    g.matrixAutoUpdate = false
    g.matrix.fromArray(f, p + 1)
    g.matrixWorldNeedsUpdate = true
    const c = cockpitRef.current
    if (Math.abs(f[p + 17] - c[0]) > 1e-3 || Math.abs(f[p + 18] - c[1]) > 1e-3 || Math.abs(f[p + 19] - c[2]) > 1e-3) {
      const next: [number, number, number] = [f[p + 17], f[p + 18], f[p + 19]]
      cockpitRef.current = next
      setCockpit(next)
    }
  })

  const pressKey = useCallback(
    (code: string) => {
      if (!mod) return
      mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 1])
      mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 0])
    },
    [mod],
  )
  const onEnter = useCallback(
    (o: SeatOccupant) => {
      if (o.isLocalUser) pressKey('F1') // cockpit view: hide own exterior
    },
    [pressKey],
  )
  const onLeave = useCallback(
    (o: SeatOccupant) => {
      if (o.isLocalUser) pressKey('F2') // outside view: draw own aircraft again
    },
    [pressKey],
  )

  // Seat origin = hip; the engine's cockpit position is the pilot's eye.
  const SEAT_DROP = 0.72
  const markerMesh = marker ? (
    <mesh position={[0, 0, 0]}>
      <boxGeometry args={[0.45, 0.08, 0.45]} />
      <meshStandardMaterial color="orange" transparent opacity={0.7} />
    </mesh>
  ) : null
  const seatPos: [number, number, number] = [cockpit[0], cockpit[1] - SEAT_DROP, cockpit[2]]
  // The host finds a seat by raycasting the crosshair against the seat's
  // child meshes, so give it a cockpit-sized volume to hit (drawn fully
  // transparent; the marker alone is a thin plate and easy to miss).
  const hitVolume = (
    <mesh position={[0, 0.5, 0]}>
      <boxGeometry args={[1.0, 1.3, 1.6]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  )
  return (
    <group ref={group} visible={valid}>
      {seat ? (
        <Seat
          id="player-cockpit"
          position={seatPos}
          exitOffset={{ forward: 0, right: -3, up: 0 }}
          interactionText="乗る"
          onEnter={onEnter}
          onLeave={onLeave}
        >
          {hitVolume}
          {markerMesh}
        </Seat>
      ) : (
        <group position={seatPos}>{markerMesh}</group>
      )}
    </group>
  )
}
