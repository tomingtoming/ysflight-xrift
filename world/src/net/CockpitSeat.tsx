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
import { Seat, useSeatContext, useTeleport, useUsers } from '@xrift/world-components'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Camera, Group, Matrix4, Quaternion, Vector3 } from 'three'
import { controlBus } from '../engine/controlBus'
import { onBeforeEngineDraw, setPiloting, useEngine } from '../engine/engineStore'
import { releaseFire, setFire } from '../engine/fireKey'
import { frameClock } from '../engine/frameClock'
import { padStatus, releaseGamepad, updateGamepad } from '../engine/gamepadStick'
import { isKeyDown } from '../engine/keyBridge'
import { mouseStick, setMouseStickEnabled } from '../engine/mouseStick'
import { StickMarker } from './StickMarker'
import { FlightHud } from './FlightHud'
import { Gunsight, HudGlass } from './HudGlass'
import { HostBadge } from './HostBadge'
import { kioskJoinPending, setKioskJoin } from './lobbyStore'
import { DEFAULT_EYE, EyeCalibrator, type EyeOffset } from './seatEye'
import { PoseHistory, SeatLead, camAnchor, clearSeatLag, devForceDelay, readFeet, readFeetAtRender } from './seatLead'
import { SaccHands } from '../vr/SaccHands'
import { TouchConsole, isCoarsePointer } from './TouchConsole'
import { saccStatus } from '../vr/saccControls'
import { publishCockpit, publishSeat } from './StateBeacon'
import { NET_FLYING, airBase, findAircraftByPilot, pilotNameOf, readNetState, requestLeave, type NetState } from './netState'

interface SeatOccupant { id: string; isLocalUser: boolean }
interface SeatControlInput { forward: number; right: number }

const STICK_RATE = 2.5
const DEAD_LEAVE_S = 3 // s with a dead aircraft before the flight is ended for the pilot
const EJECT_SETTLE_S = 4 // s after the eject during which a pilot found off the apron is brought back
const EJECT_FRAMES = 20 // frames the seat stays unmounted: the host notices, stands the pilot up, then the teleport
const ANCHOR_CAL_MAX_SPEED = 3 // m/s: below this the body sits where the seat puts it, and its offset can be learnt
export const COCKPIT_SEAT_ID = 'ysfx-cockpit'

export interface CockpitSeatProps {
  /** Where the seat rests while the player has no aircraft. */
  home: [number, number, number]
  homeYaw?: number
  /** Where a pilot whose aircraft is gone is put back on their feet (position, yaw in degrees). */
  respawn: { position: [number, number, number]; yaw: number }
}

export function CockpitSeat({ home, homeYaw = 0, respawn }: CockpitSeatProps) {
  const mod = useEngine()
  const users = useUsers()
  const { localUser } = users
  const feet = useRef(new Vector3())
  const { sit } = useSeatContext()
  const { teleport } = useTeleport()
  const respawnRef = useRef(respawn)
  respawnRef.current = respawn
  // The seat is taken away for a moment to put a pilot without an aircraft back on their feet (see eject).
  const [seatOn, setSeatOn] = useState(true)
  const ejectFrames = useRef(0)
  const deadFor = useRef(0)
  const settleLeft = useRef(0)
  const settleAcc = useRef(0)
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera)
  const group = useRef<Group>(null) // true aircraft pose: HUD, gunsight, hands
  const seatGroup = useRef<Group>(null) // the pose the host reads: true pose led by the measured delay
  const lead = useRef(new SeatLead())
  const history = useRef(new PoseHistory())
  const eyeTmp = useRef(new Vector3())
  const anchor = useRef({ active: false, mode: false, rigid: false, calN: 0, cal: new Vector3(), seat: new Vector3(), trueM: new Matrix4() })
  const camPos = useRef(new Vector3())
  const mouseWas = useRef(false)
  const mouseOwner = useRef(false)
  const padOwner = useRef(false)
  const mouseFireWas = useRef(false)
  const camShift = useRef({ cam: null as Camera | null, d: new Vector3() })
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
    releaseFire(mod)
    mod?._YsfxReleaseAllKeys()
    // Outside view for the parked aircraft -- only while the engine still
    // flies it.  Once the flight is over the engine is in its standby, where
    // F2 on a client asks to become a side window of the host's aircraft.
    if (mod && readNetState(mod, netRef.current).state === NET_FLYING) pressKey('F2')
  }, [mod, pressKey, releaseStick])

  /**
   * Stand the local pilot up without their doing: the host has no call for
   * it, but a seat that disappears puts its occupant on their feet where
   * they are.  So the seat is unmounted for a few frames, then the pilot is
   * brought to the apron (they stood up wherever the wreck was).
   */
  const eject = useCallback(() => {
    seatedRef.current = false
    publishSeat(null)
    clearSeatLag()
    setKioskJoin(false)
    setSeatOn(false)
    ejectFrames.current = EJECT_FRAMES
  }, [])

  const onControlInput = useCallback((input: SeatControlInput, delta: number) => {
    if (!mod || !flyingRef.current || saccStatus.active || mouseStick.grabbed || padStatus.active) return // VR hands / the mouse stick / a gamepad fly the aircraft
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
    anchor.current.calN = 0
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
    // Right mouse button = trigger.  Only the owning seat speaks for the mouse, and it says so on edges only.
    const mouseFire = mouseOwner.current && mouseStick.fire
    if (mouseFire !== mouseFireWas.current) { mouseFireWas.current = mouseFire; setFire(mod, 'mouse', mouseFire) }
    if (own && mouseStick.grabbed) {
      controlBus.stick('mouse', mouseStick.ail, mouseStick.elv)
      mouseWas.current = true
    } else if (mouseWas.current) {
      mouseWas.current = false
      releaseStick()
    }
    // Gamepad: any pointer type, outside XR (the XR controllers are the hands' there).
    const pad = seatedRef.current && flyingRef.current && !gl.xr?.isPresenting
    if (pad) {
      padOwner.current = true
      const had = padStatus.active
      updateGamepad(mod, dt, mod.HEAPF32[(mod._FsVrFlightDataPointer() >> 2) + 7])
      if (had && !padStatus.active) releaseStick() // the keyboard stick starts again from neutral
    } else if (padOwner.current) { padOwner.current = false; releaseGamepad(mod) }
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
        setHudOn(true) // the cockpit view itself is pinned while piloting (YsflightEngine step)
      }
    } else if (flyingRef.current) {
      // The flight is over and the pilot still sits: the aircraft is gone
      // (crashed, shot down, the field changed).  Put them back on the apron.
      const wasSeated = seatedRef.current
      endLocalFlight()
      if (wasSeated) eject()
    }
    // A dead aircraft does not end the flight by itself (the engine waits for
    // a key the host never forwards): give the pilot a moment with the wreck,
    // then leave the flight, which lands in the branch above.
    if (flying && seatedRef.current && flyingRef.current && (airIndex < 0 || mod.HEAPF32[airBase(mod, airIndex) + 1] === 0)) {
      deadFor.current += dt
      if (deadFor.current > DEAD_LEAVE_S) { deadFor.current = 0; requestLeave(mod) }
    } else deadFor.current = 0
    if (ejectFrames.current > 0 && --ejectFrames.current === 0) {
      const r = respawnRef.current
      teleport({ position: r.position, yaw: r.yaw })
      setSeatOn(true)
      settleLeft.current = EJECT_SETTLE_S
      settleAcc.current = 0
    }
    // The host may stand the pilot up after that teleport rather than before
    // it (then they stand where the seat was, feet inside the ground: seen
    // once in three production runs).  Keep checking for a few seconds and
    // bring them back until they are on the apron.
    if (settleLeft.current > 0) {
      settleLeft.current -= dt
      settleAcc.current += dt
      if (settleAcc.current > 0.5) {
        settleAcc.current = 0
        const r = respawnRef.current
        const p = readFeet(users, feet.current)
        if (p && (Math.hypot(p.x - r.position[0], p.z - r.position[2]) > 3 || p.y < r.position[1] - 0.8)) teleport({ position: r.position, yaw: r.yaw })
      }
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
    const an = anchor.current
    an.trueM.copy(g.matrix)
    an.seat.set(cp[0], cp[1] - e.dy, cp[2] - e.dz)
    an.active = active
    // Desktop (see the render-time block below): 'all' ties every view to the
    // body, 'third' only the views away from the cockpit eye; 'legacy' is v77.
    const ca = camAnchor()
    const xr = !!gl.xr?.isPresenting
    an.rigid = !xr && ca !== 'legacy' && (ca === 'all' || !firstPerson)
    an.mode = active && (xr || an.rigid || !firstPerson || devForceDelay())
    const now = frameClock.nowMs / 1000
    history.current.push(now, g.matrix)
    // The rigid desktop shift keeps the true attitude and moves at render time: no delayed sample.
    const delay = active && !an.rigid && (xr || !firstPerson || devForceDelay()) ? lead.current.lag : 0
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
      publishCockpit(seatWorld.current.set(cp[0], cp[1] - e.dy, cp[2] - e.dz).applyMatrix4(sg.matrixWorld).toArray())
    } else publishCockpit(null)
  }, -2)

  // ---- render time: anchor what the eye sees to where the body really is ----
  // The delay above assumes a body a steady `lag` behind.  The host's body is
  // a kinematic rigid body that moves when physics steps, at physics' own
  // rate: on a 72/90/120 Hz display some frames have no step and the body --
  // with the VR eye and the third-person avatar on it -- advances in stairs,
  // a physics step of travel at a time.  Against that, a smoothly delayed
  // cockpit and HUD slide back and forth ("the HUD moves violently fore and
  // aft" in VR, third person still shaking; toming, 2026-11-10).
  // So do not model the body: read it.  This runs after every host callback
  // of the frame, right before the first draw.  The follower (the XR rig in
  // VR, the body's feet otherwise) has a fixed offset from the seat origin in
  // the aircraft frame, learnt while the aircraft stands; at speed the HUD
  // group and the engine's drawn own aircraft are moved so that offset holds
  // exactly, whatever the body did this frame.  Attitude keeps the delayed
  // sample (a step of rotation is small).
  useEffect(() => {
    if (!mod) return
    const t = { F: new Vector3(), p: new Vector3(), q: new Quaternion(), qv: new Quaternion(), s: new Vector3(), v: new Vector3(), w: new Vector3(), rig: new Matrix4(), inv: new Matrix4(), one: new Vector3(1, 1, 1) }
    return onBeforeEngineDraw((drawCamera) => {
      const g = group.current
      const a = anchor.current
      let F: Vector3 | null = null
      if (gl.xr?.isPresenting) {
        const frame = gl.xr.getFrame?.() as XRFrame | null
        const space = gl.xr.getReferenceSpace?.()
        const vp = frame && space ? frame.getViewerPose(space) : null
        if (vp) {
          t.inv.fromArray(vp.transform.inverse.matrix)
          t.rig.copy(gl.xr.getCamera().matrixWorld).multiply(t.inv) // reference space -> world: what the eye rides
          F = t.F.setFromMatrixPosition(t.rig)
        }
      } else F = readFeetAtRender(users, t.F) // also advances the dev stand-in, seated or not
      if (!g || !F || !a.active) return
      a.trueM.decompose(t.p, t.q, t.s)
      t.v.copy(a.seat).applyMatrix4(a.trueM) // seat origin, world, true pose
      const speed = lead.current.speed
      if (speed < ANCHOR_CAL_MAX_SPEED) {
        t.w.subVectors(F, t.v).applyQuaternion(t.qv.copy(t.q).invert())
        if (a.calN === 0) a.cal.copy(t.w); else a.cal.lerp(t.w, 0.1)
        a.calN++
      }
      t.w.copy(a.seat).add(a.cal) // the follower's place in the aircraft frame
      const trail = t.v.copy(t.w).applyMatrix4(a.trueM).distanceTo(F)
      const ok = a.mode && a.calN >= 10 && trail < Math.max(1, speed * 0.25)
      if (ok && a.rigid) {
        // Desktop.  The host places the camera from the seat, on time, and the
        // body -- the avatar -- a frame late: at speed the avatar slides fore
        // and aft against the camera by speed x the frame-time jitter.  In
        // first person that is the headless avatar shaking behind the pilot;
        // in third person (mouse wheel) the avatar, and with it the aircraft
        // and HUD that v48 anchored to the body, shaking in front of the
        // camera (toming, 2026-11-12).  One displacement cures both: move the
        // own aircraft, the HUD and the camera together by how far the body
        // is from where the true pose would have it.  Camera against cockpit
        // is then exactly what the host set up (the first-person view that
        // was already steady), and the avatar sits still in its seat.  What
        // takes the jitter instead is the world outside, by centimetres.
        // (matrixWorld only: the host's camera.position is its own, and it
        // rebuilds the matrix next frame.)
        t.p.subVectors(F, t.v) // t.v: where the body would be on the true pose
        g.matrix.copy(a.trueM)
        const ge = g.matrix.elements
        ge[12] += t.p.x; ge[13] += t.p.y; ge[14] += t.p.z
        g.updateMatrixWorld(true)
        const vis = mod._FsVrPlayerVisualDataPointer() >> 2
        mod.HEAPF32[vis] = 1
        for (let i = 0; i < 16; i++) mod.HEAPF32[vis + 1 + i] = ge[i]
        lead.current.reportVisual(true, g.matrix)
        const me = drawCamera.matrixWorld.elements
        me[12] += t.p.x; me[13] += t.p.y; me[14] += t.p.z
        drawCamera.matrixWorldInverse.copy(drawCamera.matrixWorld).invert()
        camShift.current.cam = drawCamera
        camShift.current.d.copy(t.p)
      } else if (ok) {
        g.matrix.decompose(t.p, t.qv, t.s) // the attitude the visuals already have
        t.p.copy(F).sub(t.w.applyQuaternion(t.qv))
        g.matrix.compose(t.p, t.qv, t.one)
        g.updateMatrixWorld(true)
        const vis = mod._FsVrPlayerVisualDataPointer() >> 2
        mod.HEAPF32[vis] = 1
        for (let i = 0; i < 16; i++) mod.HEAPF32[vis + 1 + i] = g.matrix.elements[i]
        lead.current.reportVisual(true, g.matrix)
        // (The camera is left alone.  The only desktop view that is not first
        // person is the host's photo camera, a free camera fixed in the world
        // -- measured on the production host, 2026-11-10: it stays behind as
        // the aircraft leaves.  Seen from it, the anchored aircraft and the
        // avatar move together in the body's steps; that is the body's own
        // motion and not ours to smooth.)
      }
      lead.current.reportAnchor(ok, trail)
    })
  }, [mod, gl, users])

  // The camera shift is for the render only.  Take it back before anything in the next frame reads the camera:
  // the dev environment's player takes its place from the camera's world matrix, and a shift left in would
  // come back as a body one more frame behind (seen in the local suite: 2 frames of trail became 3).
  useFrame(() => {
    const c = camShift.current
    if (!c.cam) return
    const me = c.cam.matrixWorld.elements
    me[12] -= c.d.x; me[13] -= c.d.y; me[14] -= c.d.z
    c.cam.matrixWorldInverse.copy(c.cam.matrixWorld).invert()
    c.cam = null
  }, -1000)

  useEffect(() => () => endLocalFlight(), [endLocalFlight])
  useEffect(() => () => { if (padOwner.current) { padOwner.current = false; releaseGamepad(mod) } }, [mod])

  const seatPos: [number, number, number] = [cockpit[0], cockpit[1] - eye.dy, cockpit[2] - eye.dz]
  return (
    <>
      <group ref={group}>
        {hudOn ? (<group position={seatPos}><HudGlass eye={eye} /><Gunsight eye={eye} /><HostBadge eye={eye} /><FlightHud render={false} /><SaccHands /><StickMarker eye={eye} />{isCoarsePointer() ? <TouchConsole eye={eye} /> : null}</group>) : null}
      </group>
      <group ref={seatGroup}>
        {seatOn ? <Seat id={COCKPIT_SEAT_ID} position={seatPos} exitOffset={{ forward: 0, right: -3, up: 0 }}
          interactionText="操縦席に乗る" enabled={reboardable} onEnter={onEnter} onLeave={onLeave} onControlInput={onControlInput}>
          {/* cockpit-sized hit volume so the crosshair / ray finds the seat of a parked aircraft */}
          <mesh position={[0, 0.5, 0]}>
            <boxGeometry args={[1.0, 1.3, 1.6]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </Seat> : null}
      </group>
    </>
  )
}
