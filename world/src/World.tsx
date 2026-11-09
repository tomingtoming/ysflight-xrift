import { SpawnPoint } from '@xrift/world-components'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { CockpitSeat } from './net/CockpitSeat'
import { LobbyKiosk } from './net/LobbyKiosk'
import { NetSession } from './net/NetSession'
import { RemoteAircraftSeats } from './net/RemoteAircraftSeats'
import { DevHooks } from './net/DevHooks'

export interface WorldProps {
  position?: [number, number, number]
}

// Atsugi RW01_01 in the engine is (-117, 0.5, -663) LH -> three (-117, 0.5, 663).
// Visitors spawn on the runway short of it, facing +z (yaw 180); the lobby
// kiosk stands beside the spawn and the cockpit seat is parked next to it.
const APRON: [number, number, number] = [-117, 0.5, 640]

const GROUND_TILE = 400 // m; small enough that the host's character controller stands on top (see below)
const GROUND_EXTENT = 3000 // m; covers the airfield and its surroundings
const GROUND_TILES: Array<[number, number]> = []
for (let x = -GROUND_EXTENT + GROUND_TILE / 2; x < GROUND_EXTENT; x += GROUND_TILE) {
  for (let z = -GROUND_EXTENT + GROUND_TILE / 2; z < GROUND_EXTENT; z += GROUND_TILE) GROUND_TILES.push([x, z])
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0] }) => {
  return (
    <group position={position}>
      <NetSession>
        {(role, _pilot, room) => (
          <>
            {/* The standby screen in the world: pick an aircraft and a start
                position, press 飛行開始, and the cockpit seat boards you. */}
            <LobbyKiosk position={[APRON[0] + 8, 1.6, APRON[2] + 5]} yaw={Math.PI} role={role} room={room} />
            <CockpitSeat home={[APRON[0] + 6, 0.5, APRON[2] + 2]} homeYaw={Math.PI} />
            <RemoteAircraftSeats />
            {import.meta.env.DEV ? <DevHooks /> : null}
          </>
        )}
      </NetSession>

      {/* Walkable ground: an invisible slab under the whole airfield (the
          engine draws the terrain; this only carries the avatar). */}
      {/* Walkable ground: flat tiles at the engine's apron elevation (0 m;
          the beacon's ground probe reads it back from the engine).  Tiled
          because the host's character controller sinks into a huge cuboid in
          proportion to its size -- measured 2026-11-09: half-extent 3000 m
          -> feet 0.91 m below the top, 1500 m -> 0.26 m, 200 m -> 0.01 m. */}
      <RigidBody type="fixed" restitution={0} friction={0}>
        {GROUND_TILES.map(([x, z]) => (
          <CuboidCollider key={`${x},${z}`} args={[GROUND_TILE / 2, 0.5, GROUND_TILE / 2]} position={[x, -0.5, z]} />
        ))}
      </RigidBody>

      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 100, 50]} intensity={1.2} />

      <group position={APRON}>
        <SpawnPoint yaw={180} />
      </group>
    </group>
  )
}
