/**
 * CockpitSeat — the pilot's seat for flights started from the LobbyKiosk.
 *
 * It has no pedestal: while nobody flies it is parked out of reach.  When
 * the engine reports the local player's aircraft (after a kiosk join) the
 * seat moves into that cockpit and the player is sat down automatically.
 * Standing up (Space / A) leaves the flight and teleports the player back to
 * the apron; a crash or shoot-down returns the seat to the apron too, where
 * the pilot can stand up and pick again at the kiosk.
 *
 * Other clients get seats on every aircraft from RemoteAircraftSeats.
 */
import { useFrame } from '@react-three/fiber'
import { Seat, useSeatContext, useTeleport, useUsers } from '@xrift/world-components'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Matrix4, Quaternion, Vector3 } from 'three'
import { setPiloting, useEngine } from '../engine/engineStore'
import { FlightHud } from './FlightHud'
import { kioskJoinPending, setKioskJoin } from './lobbyStore'
import { publishSeat } from './StateBeacon'
import { NET_FLYING, airBase, findAircraftByPilot, pilotNameOf, readNetState, requestLeave, type NetState } from './netState'

interface SeatOccupant { id: string; isLocalUser: boolean }
interface SeatControlInput { forward: number; right: number }

const CTL_GRABBED = 0
const CTL_AILERON = 1
const CTL_ELEVATOR = 2
const CTL_STICK_EVER_GRABBED = 8
const STICK_RATE = 2.5
const SEAT_DROP = 0.72
export const COCKPIT_SEAT_ID = 'ysfx-cockpit'

export interface CockpitSeatProps {
  /** Where the seat rests (and the player is returned to) when not flying. */
  home: [number, number, number]
  homeYaw?: number
}

export function CockpitSeat({ home, homeYaw = 0 }: CockpitSeatProps) {
  const mod = useEngine()
  const { localUser } = useUsers()
  const { sit } = useSeatContext()
  const { teleport } = useTeleport()
  const group = useRef<Group>(null)
  const netRef = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0 })
  const seatedRef = useRef(false)
  const flyingRef = useRef(false)
  const satForAirRef = useRef(-1)
  const [cockpit, setCockpit] = useState<[number, number, number]>([0, 0, 0])
  const cockpitRef = useRef(cockpit)
  const [hudOn, setHudOn] = useState(false)
  const stickRef = useRef({ ail: 0, elv: 0 })
  const parked = useRef(new Matrix4().compose(new Vector3(home[0], home[1], home[2]), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), homeYaw), new Vector3(1, 1, 1)))

  const pressKey = useCallback((code: string) => {
    if (!mod) return
    mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 1])
    mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 0])
  }, [mod])

  const releaseStick = useCallback(() => {
    if (!mod) return
    const c = mod._FsVrControlDataPointer() >> 2
    mod.HEAPF32[c + CTL_GRABBED] = 0
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

  const onControlInput = useCallback((input: SeatControlInput, delta: number) => {
    if (!mod || !flyingRef.current) return
    const st = stickRef.current
    const step = STICK_RATE * Math.max(delta, 0)
    const toward = (v: number, target: number) => v + Math.max(-step, Math.min(step, target - v))
    st.ail = toward(st.ail, Math.max(-1, Math.min(1, input.right)))
    st.elv = toward(st.elv, Math.max(-1, Math.min(1, -input.forward)))
    const c = mod._FsVrControlDataPointer() >> 2
    mod.HEAPF32[c + CTL_GRABBED] = 1
    mod.HEAPF32[c + CTL_AILERON] = st.ail
    mod.HEAPF32[c + CTL_ELEVATOR] = st.elv
    mod.HEAPF32[c + CTL_STICK_EVER_GRABBED] = 1
  }, [mod])

  const onEnter = useCallback((o: SeatOccupant) => {
    if (!o.isLocalUser) return
    seatedRef.current = true
    publishSeat(COCKPIT_SEAT_ID)
  }, [])
  const onLeave = useCallback((o: SeatOccupant) => {
    if (!o.isLocalUser) return
    seatedRef.current = false
    publishSeat(null)
    setKioskJoin(false)
    if (mod) {
      endLocalFlight()
      requestLeave(mod)
    }
    teleport({ position: home, yaw: (homeYaw * 180) / Math.PI })
  }, [mod, endLocalFlight, teleport, home, homeYaw])

  useFrame(() => {
    const g = group.current
    if (!g || !mod) return
    g.matrixAutoUpdate = false
    const ns = readNetState(mod, netRef.current)
    const flying = ns.state === NET_FLYING && ns.playerAirId >= 0
    let airIndex = -1
    if (flying) {
      airIndex = findAircraftByPilot(mod, pilotNameOf(localUser ?? { id: 'local', displayName: 'pilot' }))
      // Board the player once per aircraft when the join came from the kiosk.
      if (kioskJoinPending() && !seatedRef.current && satForAirRef.current !== ns.playerAirId) {
        satForAirRef.current = ns.playerAirId
        sit(COCKPIT_SEAT_ID)
      }
      if (seatedRef.current && !flyingRef.current) {
        flyingRef.current = true
        setPiloting(true)
        setHudOn(true)
        pressKey('F1')
      }
    } else if (flyingRef.current) {
      endLocalFlight()
    }
    if (airIndex >= 0) {
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
      g.matrix.copy(parked.current)
      const c = cockpitRef.current
      if (c[0] !== 0 || c[1] !== 0 || c[2] !== 0) {
        const next: [number, number, number] = [0, 0, 0]
        cockpitRef.current = next
        setCockpit(next)
      }
    }
    g.matrixWorldNeedsUpdate = true
  })

  useEffect(() => () => endLocalFlight(), [endLocalFlight])

  return (
    <group ref={group}>
      <Seat id={COCKPIT_SEAT_ID} position={cockpit} exitOffset={{ forward: 0, right: -3, up: 0 }}
        interactionText="操縦席" enabled={false} onEnter={onEnter} onLeave={onLeave} onControlInput={onControlInput}>
        {hudOn ? <FlightHud position={[0, SEAT_DROP - 0.05, -1.4]} /> : null}
      </Seat>
    </group>
  )
}
