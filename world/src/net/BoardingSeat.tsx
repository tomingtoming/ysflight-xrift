/**
 * BoardingSeat — a pedestal on the apron that is also the pilot's seat.
 *
 * Sit down and the world asks the engine to join the session with this
 * aircraft at this start position.  Once the aircraft exists the seat rides
 * in its cockpit (the host re-reads the seat surface every frame), so the
 * avatar flies with it.  When the flight ends (shot down, crashed, left) the
 * seat snaps back to the pedestal; if the pilot is still sitting, a new
 * aircraft is requested after a short pause -- crash, respawn, go again.
 * Standing up leaves the flight.
 *
 * On other clients the same seat follows the aircraft its occupant flies,
 * found in the engine's aircraft list by the occupant's pilot name.
 */
import { useFrame } from '@react-three/fiber'
import { Seat, useUsers } from '@xrift/world-components'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Matrix4, Quaternion, Vector3 } from 'three'
import { setPiloting, useEngine } from '../engine/engineStore'
import { FlightHud } from './FlightHud'
import { HudGlass } from './HudGlass'
import { publishSeat, registerSeat } from './StateBeacon'
import {
  NET_FLYING,
  airBase,
  findAircraftByPilot,
  pilotNameOf,
  readNetState,
  requestJoin,
  requestLeave,
  type NetState,
} from './netState'

interface SeatOccupant {
  id: string
  isLocalUser: boolean
}

interface SeatControlInput {
  forward: number
  right: number
}

// fsvr.h control block (FsVrControlDataPointer)
const CTL_GRABBED = 0
const CTL_AILERON = 1 // + = roll right
const CTL_ELEVATOR = 2 // + = nose up
const CTL_STICK_EVER_GRABBED = 8
const STICK_RATE = 2.5 // full deflection per second from a binary (keyboard) input

export interface BoardingSeatProps {
  id: string
  /** Pedestal position on the apron (world). */
  position: [number, number, number]
  /** Pedestal yaw in radians (seat forward = -Z). */
  yaw?: number
  /** Engine aircraft identifier, e.g. 'F-16C_FIGHTINGFALCON'. */
  air: string
  /** Engine start position, e.g. 'RW01_01'. */
  stp: string
  /** Shown on the crosshair prompt. */
  label?: string
  color?: string
}

const SEAT_DROP = 0.72 // seat origin = hip; the engine's cockpit point is the pilot's eye
const RESPAWN_DELAY_S = 4
const JOIN_RETRY_S = 6

export function BoardingSeat({ id, position, yaw = 0, air, stp, label, color = '#3a7bd5' }: BoardingSeatProps) {
  const mod = useEngine()
  const { localUser, remoteUsers } = useUsers()
  const group = useRef<Group>(null)
  const netRef = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0 })
  const occupantRef = useRef<SeatOccupant | null>(null)
  const flyingRef = useRef(false) // local user's flight is active (seat rides the aircraft)
  const joinAtRef = useRef(0) // engine time (s) when a join may be requested
  const clockRef = useRef(0)
  const [cockpit, setCockpit] = useState<[number, number, number]>([0, SEAT_DROP + 0.45, 0])
  const cockpitRef = useRef(cockpit)
  const [hudOn, setHudOn] = useState(false)
  const stickRef = useRef({ ail: 0, elv: 0, fed: false })

  useEffect(() => {
    registerSeat(id, position)
    return () => registerSeat(id, null)
  }, [id, position])

  const pedestal = useMemo(() => {
    const m = new Matrix4()
    m.compose(new Vector3(...position), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(1, 1, 1))
    return m
  }, [position, yaw])

  const pressKey = useCallback(
    (code: string) => {
      if (!mod) return
      mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 1])
      mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 0])
    },
    [mod],
  )

  const releaseStick = useCallback(() => {
    if (!mod) return
    const c = mod._FsVrControlDataPointer() >> 2
    mod.HEAPF32[c + CTL_GRABBED] = 0 // the engine springs the stick to centre
    mod.HEAPF32[c + CTL_AILERON] = 0
    mod.HEAPF32[c + CTL_ELEVATOR] = 0
    stickRef.current.ail = 0
    stickRef.current.elv = 0
  }, [mod])

  const endLocalFlight = useCallback(() => {
    if (!flyingRef.current) return
    flyingRef.current = false
    setPiloting(false)
    setHudOn(false)
    releaseStick()
    mod?._YsfxReleaseAllKeys()
    pressKey('F2')
  }, [mod, pressKey, releaseStick])

  // The host's unified driver input (W/S, A/D, arrows, VR thumbstick, mobile
  // stick) is the stick: forward = push = nose down, right = roll right.
  // Written into the engine's VR control block, which overrides the keyboard
  // stick while [0] is set.  Keys the host does not consume (Q/A throttle,
  // Z/X/C rudder, G gear, B brake, F/R flaps, Tab afterburner) still go
  // through the keyboard bridge.
  const onControlInput = useCallback(
    (input: SeatControlInput, delta: number) => {
      if (!mod || !flyingRef.current) return
      const st = stickRef.current
      const step = STICK_RATE * Math.max(delta, 0)
      const toward = (v: number, target: number) => v + Math.max(-step, Math.min(step, target - v))
      st.ail = toward(st.ail, Math.max(-1, Math.min(1, input.right)))
      st.elv = toward(st.elv, Math.max(-1, Math.min(1, -input.forward)))
      st.fed = true
      const c = mod._FsVrControlDataPointer() >> 2
      const f = mod.HEAPF32
      f[c + CTL_GRABBED] = 1
      f[c + CTL_AILERON] = st.ail
      f[c + CTL_ELEVATOR] = st.elv
      f[c + CTL_STICK_EVER_GRABBED] = 1
    },
    [mod],
  )

  const onEnter = useCallback(
    (o: SeatOccupant) => {
      occupantRef.current = o
      if (o.isLocalUser) {
        joinAtRef.current = clockRef.current // join now
        publishSeat(id)
      }
    },
    [id],
  )
  const onLeave = useCallback(
    (o: SeatOccupant) => {
      occupantRef.current = null
      if (o.isLocalUser) {
        publishSeat(null)
        if (mod) {
          endLocalFlight()
          requestLeave(mod)
        }
      }
    },
    [mod, endLocalFlight],
  )

  // Everything else happens per frame from the engine's state blocks.
  useFrame((_s, dt) => {
    const g = group.current
    if (!g) return
    clockRef.current += dt
    g.matrixAutoUpdate = false
    const occ = occupantRef.current
    let airIndex = -1
    if (mod && occ) {
      if (occ.isLocalUser) {
        const ns = readNetState(mod, netRef.current)
        const flying = ns.state === NET_FLYING && ns.playerAirId >= 0
        if (flying && !flyingRef.current) {
          flyingRef.current = true
          setPiloting(true)
          setHudOn(true)
          pressKey('F1') // cockpit view: the engine hides our own exterior
        } else if (!flying && flyingRef.current) {
          endLocalFlight()
          joinAtRef.current = clockRef.current + RESPAWN_DELAY_S
        }
        if (flying) {
          airIndex = findAircraftByPilot(mod, pilotNameOf(localUser ?? { id: 'local', displayName: 'pilot' }))
        } else if (ns.ready && !ns.waiting && clockRef.current >= joinAtRef.current) {
          requestJoin(mod, air, stp)
          joinAtRef.current = clockRef.current + JOIN_RETRY_S
        }
      } else {
        const u = remoteUsers.find((r) => r.id === occ.id)
        if (u) airIndex = findAircraftByPilot(mod, pilotNameOf(u))
      }
    }
    if (mod && airIndex >= 0) {
      const b = airBase(mod, airIndex)
      const f = mod.HEAPF32
      g.matrix.fromArray(f, b + 3)
      const c = cockpitRef.current
      if (Math.abs(f[b + 19] - c[0]) > 1e-3 || Math.abs(f[b + 20] - SEAT_DROP - c[1]) > 1e-3 || Math.abs(f[b + 21] - c[2]) > 1e-3) {
        const next: [number, number, number] = [f[b + 19], f[b + 20] - SEAT_DROP, f[b + 21]]
        cockpitRef.current = next
        setCockpit(next)
      }
    } else {
      g.matrix.copy(pedestal)
      const c = cockpitRef.current
      if (c[0] !== 0 || c[1] !== 0.45 || c[2] !== 0) {
        const next: [number, number, number] = [0, 0.45, 0]
        cockpitRef.current = next
        setCockpit(next)
      }
    }
    g.matrixWorldNeedsUpdate = true
  })

  useEffect(() => () => endLocalFlight(), [endLocalFlight])

  return (
    <group ref={group}>
      <Seat
        id={id}
        position={cockpit}
        exitOffset={{ forward: 0, right: -3, up: 0 }}
        interactionText={`乗る: ${label ?? air}`}
        onEnter={onEnter}
        onLeave={onLeave}
        onControlInput={onControlInput}
      >
        {hudOn ? (<><HudGlass position={[0, SEAT_DROP - 0.05, -1.4]} /><FlightHud render={false} /></>) : null}
        {/* pedestal: the thing you aim at */}
        <mesh position={[0, -0.25, 0]}>
          <cylinderGeometry args={[0.55, 0.65, 0.4, 24]} />
          <meshStandardMaterial color={color} />
        </mesh>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[0.5, 0.08, 0.5]} />
          <meshStandardMaterial color="orange" transparent opacity={0.8} />
        </mesh>
        {/* cockpit-sized hit volume so the crosshair finds the seat in flight */}
        <mesh position={[0, 0.5, 0]}>
          <boxGeometry args={[1.0, 1.3, 1.6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </Seat>
    </group>
  )
}
