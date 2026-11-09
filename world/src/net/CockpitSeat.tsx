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
import { useFrame, useThree } from '@react-three/fiber'
import { Seat, useSeatContext, useTeleport, useUsers } from '@xrift/world-components'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Matrix4, Quaternion, Vector3 } from 'three'
import { setPiloting, useEngine } from '../engine/engineStore'
import { FlightHud } from './FlightHud'
import { Gunsight, HudGlass } from './HudGlass'
import { kioskJoinPending, setKioskJoin } from './lobbyStore'
import { DEFAULT_EYE, EyeCalibrator, type EyeOffset } from './seatEye'
import { SeatLead, clearSeatLag } from './seatLead'
import { SaccHands } from '../vr/SaccHands'
import { TouchConsole, isCoarsePointer } from './TouchConsole'
import { saccStatus } from '../vr/saccControls'
import { publishSeat } from './StateBeacon'
import { NET_FLYING, airBase, findAircraftByPilot, pilotNameOf, readNetState, requestLeave, type NetState } from './netState'

interface SeatOccupant { id: string; isLocalUser: boolean }
interface SeatControlInput { forward: number; right: number }

const CTL_GRABBED = 0
const CTL_AILERON = 1
const CTL_ELEVATOR = 2
const CTL_STICK_EVER_GRABBED = 8
const STICK_RATE = 2.5
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
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const group = useRef<Group>(null) // true aircraft pose: HUD, gunsight, hands
  const seatGroup = useRef<Group>(null) // the pose the host reads: true pose led by the measured delay
  const lead = useRef(new SeatLead())
  const leadVec = useRef(new Vector3())
  const camPos = useRef(new Vector3())
  const netRef = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  const seatedRef = useRef(false)
  const flyingRef = useRef(false)
  const satForAirRef = useRef(-1)
  // The engine's cockpit point (pilot's eye) in the aircraft frame; the seat
  // origin (hip) sits eye.dy below and eye.dz behind it (seatEye.ts).
  const [cockpit, setCockpit] = useState<[number, number, number]>([0, 0, 0])
  const cockpitRef = useRef(cockpit)
  const [eye, setEye] = useState<EyeOffset>(DEFAULT_EYE)
  const eyeRef = useRef(eye)
  const calib = useRef(new EyeCalibrator())
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
    if (!mod || !flyingRef.current || saccStatus.active) return // in VR the hands fly the aircraft
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
    calib.current.reset()
    lead.current.reset()
    publishSeat(COCKPIT_SEAT_ID)
  }, [])
  const onLeave = useCallback((o: SeatOccupant) => {
    if (!o.isLocalUser) return
    seatedRef.current = false
    publishSeat(null)
    clearSeatLag()
    setKioskJoin(false)
    if (mod) {
      endLocalFlight()
      requestLeave(mod)
    }
    teleport({ position: home, yaw: (homeYaw * 180) / Math.PI })
  }, [mod, endLocalFlight, teleport, home, homeYaw])

  useFrame((_s, dt) => {
    const g = group.current
    const sg = seatGroup.current
    if (!g || !sg || !mod) return
    g.matrixAutoUpdate = false
    sg.matrixAutoUpdate = false
    const cam = gl.xr?.isPresenting ? gl.xr.getCamera() : camera
    camPos.current.setFromMatrixPosition(cam.matrixWorld)
    if (seatedRef.current) {
      const cp = cockpitRef.current
      const e = eyeRef.current
      const next = calib.current.tick(dt, cam.matrixWorld, g.matrixWorld, [cp[0], cp[1] - e.dy, cp[2] - e.dz], e)
      if (next) { eyeRef.current = next; setEye(next) }
    }
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
      if (Math.abs(f[b + 19] - c[0]) > 1e-3 || Math.abs(f[b + 20] - c[1]) > 1e-3 || Math.abs(f[b + 21] - c[2]) > 1e-3) {
        const next: [number, number, number] = [f[b + 19], f[b + 20], f[b + 21]]
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
    // The host reads the seat surface after this callback (priority -2 runs
    // before its -1 camera sync and 0 body follow); lead it by the measured
    // residual delay so the camera lands on the cockpit (seatLead.ts).
    const lv = lead.current.update(dt, g.matrix, cockpitRef.current, camPos.current, seatedRef.current && flyingRef.current, leadVec.current)
    sg.matrix.copy(g.matrix)
    sg.matrix.elements[12] += lv.x
    sg.matrix.elements[13] += lv.y
    sg.matrix.elements[14] += lv.z
    g.updateMatrixWorld(true)
    sg.updateMatrixWorld(true)
  }, -2)

  useEffect(() => () => endLocalFlight(), [endLocalFlight])

  const seatPos: [number, number, number] = [cockpit[0], cockpit[1] - eye.dy, cockpit[2] - eye.dz]
  return (
    <>
      <group ref={group}>
        {hudOn ? (<group position={seatPos}><HudGlass eye={eye} /><Gunsight eye={eye} /><FlightHud render={false} /><SaccHands />{isCoarsePointer() ? <TouchConsole eye={eye} /> : null}</group>) : null}
      </group>
      <group ref={seatGroup}>
        <Seat id={COCKPIT_SEAT_ID} position={seatPos} exitOffset={{ forward: 0, right: -3, up: 0 }}
          interactionText="操縦席" enabled={false} onEnter={onEnter} onLeave={onLeave} onControlInput={onControlInput}>
          {null}
        </Seat>
      </group>
    </>
  )
}
