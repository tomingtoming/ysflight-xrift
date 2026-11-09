import { SpawnPoint, useTeleport } from '@xrift/world-components'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { useEngine } from './engine/engineStore'
import { CockpitSeat } from './net/CockpitSeat'
import { LobbyKiosk } from './net/LobbyKiosk'
import { NetSession, type NetRole } from './net/NetSession'
import { RemoteAircraftSeats } from './net/RemoteAircraftSeats'
import { DevHooks } from './net/DevHooks'
import { lobbyStpHeadings, lobbyStpNames, lobbyStpPositions } from './net/netState'
import { publishApron, setProbeBusy } from './net/StateBeacon'

export interface WorldProps {
  position?: [number, number, number]
}

/**
 * Where the apron furniture stands for the current field: the floor point of
 * the spawn, the runway direction (three.js xz, unit) and the field elevation.
 * Derived from the field's first start position once the engine has loaded
 * it; until then the Atsugi RW01 layout of the first worlds.
 */
interface Apron { spawn: [number, number, number]; dir: [number, number]; elev: number; stp: string }
const ATSUGI: Apron = { spawn: [-117, 0, 640], dir: [0, -1], elev: 0, stp: 'RW01_01' }

const GROUND_TILE = 400 // m; small enough that the host's character controller stands on top (see below)
const GROUND_TILES_PER_SIDE = 5 // 2 km around the apron: flat airfields only (hilly fields want a heightfield)
const SPAWN_AHEAD_M = 23 // the spawn stands on the runway ahead of the first start position's nose
const KIOSK_AHEAD_M = 2.6 // the kiosk faces the visitor from inside interact range (3.5 m): no walking (toming, 2026-11-09)
const ELEV_SAMPLES = 20

function Airfield({ role, room, field, setField }: { role: NetRole; room: string | null; field: string; setField?: (f: string) => void }) {
  const mod = useEngine()
  const { teleport } = useTeleport()
  const [apron, setApron] = useState<Apron>(ATSUGI)
  const done = useRef(false)
  const samples = useRef<number[]>([])
  const pending = useRef<Omit<Apron, 'elev'> | null>(null)

  // A new engine (new field) measures again.
  useEffect(() => { done.current = false; samples.current = []; pending.current = null; setProbeBusy(false) }, [mod])

  useFrame(() => {
    if (!mod || done.current) return
    const f = mod.HEAPF32
    if (!pending.current) {
      const names = lobbyStpNames(mod)
      if (names.length === 0) return
      const p = lobbyStpPositions(mod)[0]
      const h = lobbyStpHeadings(mod)[0]
      // Engine heading h (YsAtt3: positive turns left, +z north, left-handed)
      // -> three.js forward (-sin h, 0, -cos h); Atsugi RW01 (h = -10 deg) heads
      // 10 deg east of north = (+0.17, 0, -0.98) here, which the rolling
      // aircraft's velocity confirms (local kiosk test).
      const d: [number, number] = [-Math.sin(h), -Math.cos(h)]
      pending.current = { spawn: [p[0] + d[0] * SPAWN_AHEAD_M, 0, p[2] + d[1] * SPAWN_AHEAD_M], dir: d, stp: names[0] }
      setProbeBusy(true) // the beacon stops writing its own probe point meanwhile
    }
    // Field elevation under the spawn, from the engine's ground probe (median of a few frames).
    const gp = mod._FsVrGroundProbeDataPointer() >> 2
    const sp = pending.current.spawn
    if (f[gp + 3] !== 0 && Math.abs(f[gp] - sp[0]) < 0.5 && Math.abs(f[gp + 1] - sp[2]) < 0.5) samples.current.push(f[gp + 2])
    f[gp] = sp[0]
    f[gp + 1] = sp[2]
    if (samples.current.length < ELEV_SAMPLES) return
    const sorted = [...samples.current].sort((a, b) => a - b)
    const elev = sorted[sorted.length >> 1]
    const next: Apron = { ...pending.current, spawn: [sp[0], elev, sp[2]], elev }
    done.current = true
    setProbeBusy(false)
    setApron(next)
    publishApron(next)
    // Visitors who arrived before the engine knew the field stand on the old apron: bring them over.
    const movedFar = Math.hypot(next.spawn[0] - apron.spawn[0], next.spawn[2] - apron.spawn[2]) > 150
    if (movedFar) teleport({ position: [next.spawn[0], elev + 0.5, next.spawn[2]], yaw: (Math.atan2(next.dir[0], -next.dir[1]) * 180) / Math.PI })
  })

  const [sx, , sz] = apron.spawn
  const [dx, dz] = apron.dir
  const rx = -dz, rz = dx // runway-right
  const yaw = Math.atan2(-dx, -dz) // the kiosk stands ahead of the spawn and faces back toward it (-d)
  const spawnYawDeg = (Math.atan2(dx, -dz) * 180) / Math.PI // the visitor faces along the runway, at the kiosk (+d)
  const e = apron.elev
  const tiles: Array<[number, number]> = []
  const half = Math.floor(GROUND_TILES_PER_SIDE / 2)
  for (let i = -half; i <= half; i++) for (let j = -half; j <= half; j++) tiles.push([sx + i * GROUND_TILE, sz + j * GROUND_TILE])
  return (
    <>
      {/* The standby screen in the world: pick an aircraft, a start position and
          (host only) the field, press 飛行開始, and the cockpit seat boards you. */}
      <LobbyKiosk position={[sx + KIOSK_AHEAD_M * dx, e + 1.6, sz + KIOSK_AHEAD_M * dz]} yaw={yaw} role={role} room={room} field={field} onField={setField} defaultStp={apron.stp} />
      <CockpitSeat home={[sx + 6 * rx - 2 * dx, e + 0.5, sz + 6 * rz - 2 * dz]} homeYaw={yaw} />
      <RemoteAircraftSeats />
      {import.meta.env.DEV ? <DevHooks onField={setField} /> : null}

      {/* Walkable ground: flat tiles at the field's apron elevation (the
          engine draws the terrain; this only carries the avatar).  Tiled
          because the host's character controller sinks into a huge cuboid in
          proportion to its size -- measured 2026-11-09: half-extent 3000 m
          -> feet 0.91 m below the top, 1500 m -> 0.26 m, 200 m -> 0.01 m. */}
      <RigidBody key={`${sx},${sz},${e}`} type="fixed" restitution={0} friction={0}>
        {tiles.map(([x, z]) => (
          <CuboidCollider key={`${x},${z}`} args={[GROUND_TILE / 2, 0.5, GROUND_TILE / 2]} position={[x, e - 0.5, z]} />
        ))}
      </RigidBody>

      <group position={[sx, e + 0.5, sz]}>
        <SpawnPoint yaw={spawnYawDeg} />
      </group>
    </>
  )
}

export const World: React.FC<WorldProps> = ({ position = [0, 0, 0] }) => {
  return (
    <group position={position}>
      <NetSession>
        {(role, _pilot, room, field, setField) => <Airfield role={role} room={room} field={field} setField={setField} />}
      </NetSession>
      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 100, 50]} intensity={1.2} />
    </group>
  )
}
