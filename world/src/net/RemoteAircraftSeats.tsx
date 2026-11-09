/**
 * RemoteAircraftSeats — a passenger seat on every other aircraft in the
 * session, so an avatar can ride along in someone else's aircraft.  The
 * seat sits behind the pilot's eye point and follows the aircraft's pose
 * from the engine's aircraft list every frame.
 */
import { useFrame } from '@react-three/fiber'
import { Seat } from '@xrift/world-components'
import { useRef, useState } from 'react'
import { Group } from 'three'
import { useEngine } from '../engine/engineStore'
import { airBase, airCount } from './netState'

const PASSENGER_OFFSET: [number, number, number] = [0, -0.72, 1.1] // behind the pilot, hip height

interface Entry {
  id: number
  cockpit: [number, number, number]
}

export function RemoteAircraftSeats() {
  const mod = useEngine()
  const [entries, setEntries] = useState<Entry[]>([])
  const groups = useRef(new Map<number, Group>())
  const sig = useRef('')

  useFrame(() => {
    if (!mod) return
    const n = airCount(mod)
    const f = mod.HEAPF32
    let s = ''
    const next: Entry[] = []
    for (let i = 0; i < n; i++) {
      const b = airBase(mod, i)
      const id = f[b]
      const alive = f[b + 1] !== 0
      const isPlayer = f[b + 2] !== 0
      if (!alive || isPlayer) continue
      s += id + ','
      next.push({ id, cockpit: [f[b + 19], f[b + 20], f[b + 21]] })
      const g = groups.current.get(id)
      if (g) {
        g.matrixAutoUpdate = false
        g.matrix.fromArray(f, b + 3)
        g.updateMatrixWorld(true) // the host reads the seat surface after this callback
      }
    }
    if (s !== sig.current) {
      sig.current = s
      setEntries(next)
    }
  }, -2)

  return (
    <>
      {entries.map((e) => (
        <group
          key={e.id}
          ref={(g) => {
            if (g) groups.current.set(e.id, g)
            else groups.current.delete(e.id)
          }}
        >
          <Seat
            id={`ysfx-air-${e.id}`}
            position={[e.cockpit[0] + PASSENGER_OFFSET[0], e.cockpit[1] + PASSENGER_OFFSET[1], e.cockpit[2] + PASSENGER_OFFSET[2]]}
            exitOffset={{ forward: 0, right: -3, up: 0 }}
            interactionText="同乗する"
          >
            <mesh position={[0, 0.5, 0]}>
              <boxGeometry args={[1.0, 1.3, 1.6]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          </Seat>
        </group>
      ))}
    </>
  )
}
