import { SpawnPoint, useTeleport, useUsers } from '@xrift/world-components'
import { CuboidCollider, RigidBody } from '@react-three/rapier'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
import { useEffect, useRef, useState } from 'react'
import { useEngine } from './engine/engineStore'
import { setLoad } from './engine/loadStore'
import { LoadingPanel } from './net/LoadingPanel'
import { GroundPatch } from './net/GroundPatch'
import { CockpitSeat } from './net/CockpitSeat'
import { LobbyKiosk } from './net/LobbyKiosk'
import { SessionPanel } from './net/SessionPanel'
import { NetSession, type NetRole } from './net/NetSession'
import { RemoteAircraftSeats } from './net/RemoteAircraftSeats'
import { DevHooks } from './net/DevHooks'
import { lobbyStpHeadings, lobbyStpNames, lobbyStpPositions } from './net/netState'
import { localSeatId, publishApron, setProbeBusy } from './net/StateBeacon'
import { readFeet } from './net/seatLead'

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
// The engine's own answer for Atsugi RW01_01 (prod beacon, 2026-11-09), so the
// apron -- spawn point, kiosk, parked aircraft -- does not jump when the engine
// loads the default field a few seconds after the visitor arrived.  A phone
// visitor had aimed at the kiosk's first spot and tapped into thin air once it
// moved 4.9 m.  Other fields still move it, by hundreds of metres, with a teleport.
const SPAWN_AHEAD_M = 23 // abeam a point ahead of the first start position's nose
// Beside the runway, not on it (toming, 2026-11-11: standing on the runway is
// uneasy).  To the right of the take-off direction, clear of the widest
// runways' edge (half-width 30 m or so).
const SPAWN_SIDE_M = 40
function apronSpot(p: ArrayLike<number>, d: [number, number], side = SPAWN_SIDE_M): [number, number, number] {
  return [p[0] + d[0] * SPAWN_AHEAD_M - d[1] * side, 0, p[2] + d[1] * SPAWN_AHEAD_M + d[0] * side]
}
// Tried in this order after the runway point itself (index 0, the reference
// level): the first side whose ground is level with the runway wins; a field
// with a slope or a cliff on both sides keeps the apron on the runway.
const SIDE_CANDIDATES = [0, SPAWN_SIDE_M, -SPAWN_SIDE_M]
const SIDE_LEVEL_M = 1.5
const ATSUGI_DIR: [number, number] = [0.17365, -0.98481]
const ATSUGI: Apron = { spawn: apronSpot([-116.99994, 0, 663.19962], ATSUGI_DIR), dir: ATSUGI_DIR, elev: 0, stp: 'RW01_01' }

const GROUND_TILE = 400 // m; small enough that the host's character controller stands on top (see below)
const GROUND_TILES_PER_SIDE = 5 // 2 km around the apron: flat airfields only (hilly fields want a heightfield)
const LOADING_AHEAD_M = 2.0 // the loading panel stands in front of the kiosk and hides it until the field is ready
const KIOSK_AHEAD_M = 2.6 // the kiosk faces the visitor from inside interact range (3.5 m): no walking (toming, 2026-11-09)
const ELEV_SAMPLES = 20

function Airfield({ role, room, field, setField }: { role: NetRole; room: string | null; field: string; setField?: (f: string) => void }) {
  const mod = useEngine()
  const { teleport } = useTeleport()
  const users = useUsers()
  const camera = useThree((st) => st.camera)
  const feetTmp = useRef(new Vector3())
  const [apron, setApron] = useState<Apron>(ATSUGI)
  const done = useRef(false)
  const samples = useRef<number[]>([])
  const pending = useRef<Omit<Apron, 'elev'> | null>(null)
  const stp = useRef<{ p: [number, number, number]; d: [number, number] } | null>(null)
  const cand = useRef(0)
  const elevs = useRef<number[]>([])

  // A new engine (new field) measures again.
  useEffect(() => { done.current = false; samples.current = []; pending.current = null; stp.current = null; cand.current = 0; elevs.current = []; setProbeBusy(false) }, [mod])

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
      stp.current = { p: [p[0], p[1], p[2]], d }
      pending.current = { spawn: apronSpot(p, d, SIDE_CANDIDATES[0]), dir: d, stp: names[0] }
      setProbeBusy(true) // the beacon stops writing its own probe point meanwhile
    }
    // Field elevation under the spawn, from the engine's ground probe (median of a few frames).
    const gp = mod._FsVrGroundProbeDataPointer() >> 2
    const q = pending.current.spawn
    if (f[gp + 3] !== 0 && Math.abs(f[gp] - q[0]) < 0.5 && Math.abs(f[gp + 1] - q[2]) < 0.5) samples.current.push(f[gp + 2])
    f[gp] = q[0]
    f[gp + 1] = q[2]
    if (samples.current.length < ELEV_SAMPLES) return
    const sorted = [...samples.current].sort((a, b) => a - b)
    elevs.current.push(sorted[sorted.length >> 1])
    samples.current = []
    if (elevs.current.length < SIDE_CANDIDATES.length) {
      cand.current = elevs.current.length
      pending.current = { ...pending.current, spawn: apronSpot(stp.current!.p, stp.current!.d, SIDE_CANDIDATES[cand.current]) }
      return
    }
    let pick = 0
    for (let i = 1; i < SIDE_CANDIDATES.length; i++) if (Math.abs(elevs.current[i] - elevs.current[0]) < SIDE_LEVEL_M) { pick = i; break }
    const elev = elevs.current[pick]
    const sp = apronSpot(stp.current!.p, stp.current!.d, SIDE_CANDIDATES[pick])
    console.info(`[ysfx] apron: start position y ${stp.current!.p[1].toFixed(1)} m, runway ${elevs.current[0].toFixed(1)} m, right ${elevs.current[1].toFixed(1)} m, left ${elevs.current[2].toFixed(1)} m -> ${['on the runway', 'right', 'left'][pick]}`)
    const next: Apron = { ...pending.current, spawn: [sp[0], elev, sp[2]], elev }
    done.current = true
    setProbeBusy(false)
    setLoad('ready')
    setApron(next)
    publishApron(next)
    // Whoever is not near this apron is brought to it: visitors who stood on
    // the previous field's apron, and visitors the host dropped at the world
    // origin before this world had mounted its spawn point (a guest stayed
    // there, 650 m from the kiosk, once the ground patch gave the origin a
    // floor; before that they fell and were respawned -- production, 2026-11-10).
    const here = readFeet(users, feetTmp.current) ?? camera.position
    const movedFar = localSeatId() === null && Math.hypot(next.spawn[0] - here.x, next.spawn[2] - here.z) > 150
    if (movedFar) teleport({ position: [next.spawn[0], elev + 0.5, next.spawn[2]], yaw: (Math.atan2(-next.dir[0], -next.dir[1]) * 180) / Math.PI })
  })

  const [sx, , sz] = apron.spawn
  const [dx, dz] = apron.dir
  const rx = -dz, rz = dx // runway-right
  const yaw = Math.atan2(-dx, -dz) // the kiosk stands ahead of the spawn and faces back toward it (-d)
  // The visitor faces along the runway, at the kiosk (+d).  The host's yaw is a
  // three.js rotation about +y: forward (-sin, -cos).  The sign was the other
  // way until 2026-11-11 -- 20 deg off at Atsugi (heading 10 deg), unnoticed;
  // 153 deg off at Matsushima RW25 in production.
  const spawnYawDeg = (Math.atan2(-dx, -dz) * 180) / Math.PI
  const e = apron.elev
  const tiles: Array<[number, number]> = []
  const half = Math.floor(GROUND_TILES_PER_SIDE / 2)
  for (let i = -half; i <= half; i++) for (let j = -half; j <= half; j++) tiles.push([sx + i * GROUND_TILE, sz + j * GROUND_TILE])
  return (
    <>
      {/* The standby screen in the world: pick an aircraft, a start position and
          (host only) the field, press 飛行開始, and the cockpit seat boards you. */}
      <LobbyKiosk position={[sx + KIOSK_AHEAD_M * dx, e + 1.6, sz + KIOSK_AHEAD_M * dz]} yaw={yaw} role={role} room={room} field={field} onField={setField} defaultStp={apron.stp} previewSide={[-rx, -rz]} previewAhead={[dx, dz]} />
      <SessionPanel position={[sx + KIOSK_AHEAD_M * dx + 1.55 * rx, e + 1.6, sz + KIOSK_AHEAD_M * dz + 1.55 * rz]} yaw={yaw} role={role} />
      <LoadingPanel position={[sx + LOADING_AHEAD_M * dx, e + 1.6, sz + LOADING_AHEAD_M * dz]} yaw={yaw} field={field} />
      <CockpitSeat home={[sx + 6 * rx - 2 * dx, e + 0.5, sz + 6 * rz - 2 * dz]} homeYaw={yaw} respawn={{ position: [sx, e + 0.5, sz], yaw: spawnYawDeg }} />
      <RemoteAircraftSeats />
      <GroundPatch />
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

      {/* Keyed by the place: the platform's SpawnPoint reports its position
          once, when mounted, so a new field needs a new one -- otherwise a
          respawn on any other field lands on Atsugi's apron. */}
      <group key={`spawn:${sx},${e},${sz}`} position={[sx, e + 0.5, sz]}>
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
