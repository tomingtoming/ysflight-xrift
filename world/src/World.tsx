import { SpawnPoint } from '@xrift/world-components'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { PlayerAircraft } from './engine/PlayerAircraft'
import { YsflightEngine } from './engine/YsflightEngine'

export interface WorldProps {
  position?: [number, number, number]
}

// Atsugi RW01_01 in the engine is (-117, 0.5, -663) LH -> three (-117, 0.5, 663).
// Stand the visitor on the runway 23 m short of it, facing +z (yaw 180).
const APRON: [number, number, number] = [-117, 0.5, 640]

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0] }) => {
  return (
    <group position={position}>
      <YsflightEngine args={['-freeflight', 'F-16C_FIGHTINGFALCON', 'ATSUGI_AIRBASE', 'RW01_01']} />
      <PlayerAircraft marker seat={/[?&]seat=1/.test(location.search)} />

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
