import { SpawnPoint } from '@xrift/world-components'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { BoardingSeat } from './net/BoardingSeat'
import { NetSession } from './net/NetSession'
import { RemoteAircraftSeats } from './net/RemoteAircraftSeats'
import { DevHooks } from './net/DevHooks'

export interface WorldProps {
  position?: [number, number, number]
}

// Atsugi RW01_01 in the engine is (-117, 0.5, -663) LH -> three (-117, 0.5, 663).
// Visitors spawn on the runway short of it, facing +z (yaw 180); the boarding
// pedestals stand in a row beside the spawn.
const APRON: [number, number, number] = [-117, 0.5, 640]

const BOARDING: Array<{ air: string; stp: string; label: string; color: string }> = [
  { air: 'F-16C_FIGHTINGFALCON', stp: 'RW01_01', label: 'F-16C', color: '#3a7bd5' },
  { air: 'F-16C_FIGHTINGFALCON', stp: 'RW01_02', label: 'F-16C', color: '#3a7bd5' },
  { air: 'F-16C_FIGHTINGFALCON', stp: 'RW01_03', label: 'F-16C', color: '#3a7bd5' },
  { air: 'F-16C_FIGHTINGFALCON', stp: 'RW01_04', label: 'F-16C', color: '#3a7bd5' },
]

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0] }) => {
  return (
    <group position={position}>
      <NetSession>
        {() => (
          <>
            {BOARDING.map((b, i) => (
              <BoardingSeat
                key={b.stp}
                id={`ysfx-board-${b.stp}`}
                position={[APRON[0] - 6 + i * 4, 0.5, APRON[2] + 6]}
                yaw={Math.PI}
                air={b.air}
                stp={b.stp}
                label={`${b.label} ${b.stp}`}
                color={b.color}
              />
            ))}
            <RemoteAircraftSeats />
            {import.meta.env.DEV ? <DevHooks /> : null}
          </>
        )}
      </NetSession>

      {/* Walkable ground: an invisible slab under the whole airfield (the
          engine draws the terrain; this only carries the avatar). */}
      <RigidBody type="fixed" restitution={0} friction={0}>
        <CuboidCollider args={[3000, 0.5, 3000]} position={[0, -0.5, 0]} />
      </RigidBody>

      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 100, 50]} intensity={1.2} />

      <group position={APRON}>
        <SpawnPoint yaw={180} />
      </group>
    </group>
  )
}
