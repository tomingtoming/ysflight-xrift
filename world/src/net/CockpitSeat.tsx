/**
 * CockpitSeat — the pilot's seat for flights started from the LobbyKiosk.
 *
 * It has no pedestal: while the player has no aircraft it is parked out of
 * reach.  When the engine reports the local player's aircraft (after a kiosk
 * join) the seat moves into that cockpit and the player is sat down
 * automatically.  Standing up (Space / A) leaves the aircraft where it is --
 * throttle idle, brake on, exterior drawn -- and the seat stays in the
 * cockpit so the pilot can walk back and board again; the kiosk's 飛行開始
 * replaces the parked aircraft with the new one.  A crash or shoot-down
 * returns the seat to the apron, where the pilot stands up and picks again.
 *
 * Other clients get seats on every aircraft from RemoteAircraftSeats.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { Seat, useSeatContext, useUsers } from '@xrift/world-components'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Group, Matrix4, Quaternion, Vector3 } from 'three'
import { controlBus } from '../engine/controlBus'
import { setPiloting, useEngine } from '../engine/engineStore'
import { frameClock } from '../engine/frameClock'
import { isKeyDown } from '../engine/keyBridge'
import { mouseStick, setMouseStickEnabled } from '../engine/mouseStick'
import { StickMarker } from './StickMarker'
import { FlightHud } from './FlightHud'
import { Gunsight, HudGlass } from './HudGlass'
import { kioskJoinPending, setKioskJoin } from './lobbyStore'
import { DEFAULT_EYE, EyeCalibrator, type EyeOffset } from './seatEye'
import { PoseHistory, SeatLead, clearSeatLag, devForceDelay, readFeet } from './seatLead'
import { SaccHands } from '../vr/SaccHands'
import { TouchConsole, isCoarsePointer } from './TouchConsole'
import { saccStatus } from '../vr/saccControls'
import { publishCockpit, publishSeat } from './StateBeacon'
import { NET_FLYING, airBase, findAircraftByPilot, pilotNameOf, readNetState, type NetState } from './netState'

interface SeatOccupant { id: string; isLocalUser: boolean }
interface SeatControlInput { forward: number; right: number }

const STICK_RATE = 2.5
export const COCKPIT_SEAT_ID = 'ysfx-cockpit'

export interface CockpitSeatProps {
  /** Where the seat rests while the player has no aircraft. */
  home: [number, number, number]
  homeYaw?: number
}

export function CockpitSeat({ home, homeYaw = 0 }: CockpitSeatProps) {
  const mod = useEngine()
  const users = useUsers()
  const { localUser } = users
  const feet = useRef(new Vector3())
  const { sit } = useSeatContext()
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const group = useRef<Group>(null) // true aircraft pose: HUD, gunsight, hands
  const seatGroup = useRef<Group>(null) // the pose the host reads: true pose led by the measured delay
  const lead = useRef(new SeatLead())
  const history = useRef(new PoseHistory())
  const eyeTmp = useRef(new Vector3())
  const camPos = useRef(new Vector3())
  const mouseWas = useRef(false)
  const mouseOwner = useRef(false)
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
  /** The aircraft exists and nobody local sits: the seat can be clicked to board again. */
  const [reboardable, setReboardable] = useState(false)
  const stickRef = useRef({ ail: 0, elv: 0 })
  // Key taps release on the next frame (the engine sees key-state edges per step).
  const tapRelease = useRef<string[]>([])
  const seatWorld = useRef(new Vector3())
  const parked = useRef(new Matrix4().compose(new Vector3(home[0], home[1], home[2]), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), homeYaw), new Vector3(1, 1, 1)))

  const pressKey = useCallback((code: string) => {
    if (!mod) return
    mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 1])
    mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 0])
  }, [mod])

  const tapKey = useCallback((code: string) => {
    if (!mod) return
    mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 1])
    tapRelease.current.push(code)
  }, [mod])

  /** Leave the aircraft standing: throttle idle, brake on. */
  const parkAircraft = useCallback(() => {
    if (!mod) return
    const f = mod.HEAPF32
    const d = mod._FsVrFlightDataPointer() >> 2
    if (f[d] !== 0 && f[d + 10] < 0.5) tapKey('KeyB') // the idle throttle is enforced per frame below
  }, [mod, tapKey])

  /** The keyboard/joystick stick starts again from neutral (claims simply stop: controlBus). */
  const releaseStick = useCallback(() => {
    stickRef.current.ail = 0
    stickRef.current.elv = 0
  }, [])

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
    if (!mod || !flyingRef.current || saccStatus.active || mouseStick.grabbed) return // VR hands / the mouse stick fly the aircraft
    const st = stickRef.current
    const step = STICK_RATE * Math.max(delta, 0)
    const toward = (v: number, target: number) => v + Math.max(-step, Math.min(step, target - v))
    // The host folds A/D into `right`, but A/D are YSFLIGHT's throttle keys
    // (they reach the engine through the key bridge): take their share back
    // out so the arrows alone roll and A only throttles down.
    const right = input.right - (isKeyDown('KeyD') ? 1 : 0) + (isKeyDown('KeyA') ? 1 : 0)
    st.ail = toward(st.ail, Math.max(-1, Math.min(1, right)))
    st.elv = toward(st.elv, Math.max(-1, Math.min(1, -input.forward)))
    controlBus.stick('host', st.ail, st.elv)
  }, [mod])

  const onEnter = useCallback((o: SeatOccupant) => {
    if (!o.isLocalUser) return
    seatedRef.current = true
    calib.current.reset()
    lead.current.reset()
    history.current.reset()
    publishSeat(COCKPIT_SEAT_ID)
    // Boarding again: hand the throttle back to the keys (parkAircraft set the block).
    controlBus.throttleToKeys()
  }, [])
  const onLeave = useCallback((o: SeatOccupant) => {
    if (!o.isLocalUser) return
    seatedRef.current = false
    publishSeat(null)
    clearSeatLag()
    setKioskJoin(false)
    // The aircraft stays in the session, parked; the host puts the player at
    // the seat's exit position beside it.
    endLocalFlight()
    parkAircraft()
  }, [endLocalFlight, parkAircraft])

  useFrame(() => {
    const g = group.current
    const sg = seatGroup.current
    if (!g || !sg || !mod) return
    const dt = frameClock.dt
    g.matrixAutoUpdate = false
    sg.matrixAutoUpdate = false
    for (const code of tapRelease.current) mod.ccall('YsfxKeyByCode', 'number', ['string', 'number'], [code, 0])
    tapRelease.current.length = 0
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
    // Mouse stick (left button held) on fine-pointer desktops outside XR.
    // Only the seat that holds the flying local player owns the mouse stick
    // (every other seat instance runs this loop too and must not switch it off).
    const own = seatedRef.current && flyingRef.current && !isCoarsePointer() && !gl.xr?.isPresenting
    if (own && !mouseOwner.current) { mouseOwner.current = true; setMouseStickEnabled(true) }
    else if (!own && mouseOwner.current) { mouseOwner.current = false; setMouseStickEnabled(false) }
    if (own && mouseStick.grabbed) {
      controlBus.stick('mouse', mouseStick.ail, mouseStick.elv)
      mouseWas.current = true
    } else if (mouseWas.current) {
      mouseWas.current = false
      releaseStick()
    }
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
    const canBoard = flying && airIndex >= 0 && !seatedRef.current
    if (canBoard !== reboardable) setReboardable(canBoard)
    if (flying && !seatedRef.current) {
      // Parked: idle throttle, claimed every frame nobody is aboard.
      controlBus.park()
    }
    // Desktop first person: the camera sits on the cockpit eye point of the
    // previous frame's HUD pose (g.matrixWorld is still last frame's here).
    const cp0 = cockpitRef.current
    eyeTmp.current.set(cp0[0], cp0[1], cp0[2]).applyMatrix4(g.matrixWorld)
    const firstPerson = camPos.current.distanceTo(eyeTmp.current) < 0.6
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
    // before its -1 camera sync and 0 body follow) and gets the TRUE pose.
    // Its body lands a frame late, and in VR the eye rides the body, so what
    // the eye sees of the aircraft -- the HUD group here, the engine's drawn
    // own aircraft through the player-visual block -- is sampled from the
    // true pose history the body's measured lag back (seatLead.ts).  The
    // desktop first-person camera is placed from the seat itself, on time:
    // no delay there.  Third person shows the avatar: delay as in VR.
    const cp = cockpitRef.current, e = eyeRef.current
    const body = readFeet(users, feet.current)
    const ref: [number, number, number] = body ? [cp[0], cp[1] - e.dy, cp[2] - e.dz] : cp
    const active = seatedRef.current && flyingRef.current
    lead.current.update(dt, g.matrix, ref, body ?? camPos.current, active)
    sg.matrix.copy(g.matrix)
    const now = frameClock.nowMs / 1000
    history.current.push(now, g.matrix)
    const delay = active && (gl.xr?.isPresenting || !firstPerson || devForceDelay()) ? lead.current.lag : 0
    const vis = mod._FsVrPlayerVisualDataPointer() >> 2
    if (delay > 0.0005 && history.current.sample(now - delay, g.matrix)) {
      mod.HEAPF32[vis] = 1
      for (let i = 0; i < 16; i++) mod.HEAPF32[vis + 1 + i] = g.matrix.elements[i]
    } else mod.HEAPF32[vis] = 0
    lead.current.reportVisual(mod.HEAPF32[vis] !== 0, g.matrix)
    g.updateMatrixWorld(true)
    sg.updateMatrixWorld(true)
    if (airIndex >= 0) {
      const cp = cockpitRef.current, e = eyeRef.current
      publishCockpit(seatWorld.current.set(cp[0], cp[1] - e.dy, cp[2] - e.dz).applyMatrix4(g.matrixWorld).toArray())
    } else publishCockpit(null)
  }, -2)

  useEffect(() => () => endLocalFlight(), [endLocalFlight])

  const seatPos: [number, number, number] = [cockpit[0], cockpit[1] - eye.dy, cockpit[2] - eye.dz]
  return (
    <>
      <group ref={group}>
        {hudOn ? (<group position={seatPos}><HudGlass eye={eye} /><Gunsight eye={eye} /><FlightHud render={false} /><SaccHands /><StickMarker eye={eye} />{isCoarsePointer() ? <TouchConsole eye={eye} /> : null}</group>) : null}
      </group>
      <group ref={seatGroup}>
        <Seat id={COCKPIT_SEAT_ID} position={seatPos} exitOffset={{ forward: 0, right: -3, up: 0 }}
          interactionText="操縦席に乗る" enabled={reboardable} onEnter={onEnter} onLeave={onLeave} onControlInput={onControlInput}>
          {/* cockpit-sized hit volume so the crosshair / ray finds the seat of a parked aircraft */}
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[1.0, 1.3, 1.6]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </Seat>
      </group>
    </>
  )
}
