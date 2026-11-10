/**
 * StateBeacon — a read-only observation channel for automated tests.
 *
 * Ten times a second the world dispatches a `ysfx-state` CustomEvent on window
 * carrying the engine's session state, the player's flight data and the
 * HUD lines.  Tests (Playwright, on the real XRift host or the dev
 * environment) subscribe to it; nothing is written to globals, so the
 * channel passes XRift's code-security rules and ships in production.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { kioskClicks, kioskHovers, kioskJoinPending } from './lobbyStore'
import { useRef } from 'react'
import { Quaternion, Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { useUsers } from '@xrift/world-components'
import { ysfxStats } from '../engine/YsflightEngine'
import { airBase, airCount, airName, readNetState, type NetState } from './netState'
import type { NetRole } from './NetSession'
import { eyeCalibration, type EyeReport } from './seatEye'
import { readFeet, seatLag, type LagReport } from './seatLead'
import { controlBus } from '../engine/controlBus'
import { loadState } from '../engine/loadStore'
import { engineBuildId } from '../engine/loadEngine'
import { saccStatus } from '../vr/saccControls'
import { mouseStick } from '../engine/mouseStick'
import { isCoarsePointer } from './TouchConsole'

export interface YsfxBeacon {
  t: number
  role: NetRole | null
  room: string | null
  net: NetState | null
  flight: number[] | null
  aircraft: Array<{ id: number; alive: boolean; player: boolean; name: string; pos: number[] }>
  hud: string[] | null
  /** Seat id the local user occupies (BoardingSeat), null when standing. */
  seat: string | null
  /** Engine draw calls so far (per-eye in XR) -- tells whether the engine renders at all. */
  draws: number
  bg: number
  /** Local camera world pose (the XR camera while presenting): lets a VR test map world -> tracking space. */
  cam: { pos: number[]; quat: number[] } | null
  /** Keys the engine was handed (count, last `code->fskey`). */
  keys: { n: number; last: string }
  /** The cockpit seat's origin in world while the local player's aircraft exists (parked or flown). */
  cockpit: number[] | null
  /** The session's field (host's choice), the engine's field list, and the apron placed for it. */
  field: { current: string | null; names: string[] }
  apron: { spawn: number[]; dir: number[]; elev: number; stp: string } | null
  /** World position of the kiosk's 飛行開始 button centre. */
  kioskBtn: number[] | null
  /** The showroom preview behind the kiosk. */
  preview: { air: string; pos: number[]; radius: number } | null
  /** The session panel: its buttons (world centres) and the engine console lines it shows. */
  panel: { buttons: Array<{ name: string; pos: number[] }>; log: string[] } | null
  /** World centres of the kiosk's field-column items on the current page. */
  kioskItems: Array<{ name: string; pos: number[] }>
  /** Where the last engine draw went: viewport, eye, host render target, framebuffer bound, drawing buffer. */
  gfx: { vp: number[]; eye: number; rt: null | { w: number; h: number; samples: number }; fb: boolean; buf: number[] }
  /** Engine VR control block [0..8]: stick grabbed, aileron, elevator, rudder, throttle grabbed, throttle, throttle ever, confirm, stick ever. */
  ctl: number[] | null
  ctlOwner?: string | null
  load?: { stage: string; progress: number | null }
  /** The engine's main-window view mode (FSCOCKPITVIEW = 0). */
  view?: number
  engine?: string | null
  /** SaccFlight-style hand controls (vr/saccControls.ts) while presenting and seated. */
  vr: typeof saccStatus
  /** Seat eye calibration: measured hip-to-eye and the residual after applying it (seatEye.ts). */
  eye: EyeReport | null
  /** [aircraft templates, start positions] offered by the kiosk, once loaded. */
  lobby: number[] | null
  kiosk: { hovers: number; lastPointer: string; ev: Record<string, number> }
  /** Ground check: camera height, the avatar's feet (host movement), and the engine's terrain under the feet. */
  ground: { cam: number; feet: number[] | null; field: number | null; deck?: boolean }
  /** Seated camera lag along the velocity and the lead applied (seatLead.ts). */
  lag: LagReport | null
  /** Phone switch panel button centres (TouchConsole), null when not shown. */
  console: Array<{ id: string; pos: number[] }> | null
  /** Mouse stick (engine/mouseStick.ts): enabled while flying on desktop, grabbed while the left button is held. */
  mouse: { enabled: boolean; grabbed: boolean; ail: number; elv: number; grabs: number }
  /** Input device gates: coarse pointer (phone panel), XR presenting (hands). */
  gates: { coarse: boolean; xr: boolean }
}

let lobbyCounts: number[] | null = null
/** LobbyKiosk publishes [aircraft, start positions] once loaded. */
export function publishLobby(counts: number[] | null): void {
  lobbyCounts = counts
}

let consoleButtons: Array<{ id: string; pos: number[] }> | null = null
/** TouchConsole publishes its button centres (world) while shown. */
export function publishConsole(list: Array<{ id: string; pos: number[] }> | null): void {
  consoleButtons = list
}

let cockpitWorld: number[] | null = null
/** CockpitSeat publishes its seat origin (world) while an aircraft carries it; null when parked out of reach. */
export function publishCockpit(pos: number[] | null): void {
  cockpitWorld = pos
}

let localSeat: string | null = null
/** The seat the local user occupies, for other world code (LobbyKiosk). */
export function localSeatId(): string | null { return localSeat }
/** The seat publishes the local user's seat here. */
export function publishSeat(id: string | null): void {
  localSeat = id
}

let hudLines: string[] | null = null
/** FlightHud publishes its lines here (module-level, not a global). */
export function publishHud(lines: string[] | null): void {
  hudLines = lines
}

let probeBusy = false
/** Airfield owns the ground probe while it measures the apron elevation. */
export function setProbeBusy(b: boolean): void { probeBusy = b }
export function isProbeBusy(): boolean { return probeBusy }
/** GroundPatch publishes what the engine answered for the spot under the local player. */
let groundUnder: { height: number; deck: boolean } | null = null
export function publishGround(g: { height: number; deck: boolean } | null): void { groundUnder = g }

let kioskBtn: number[] | null = null
/** LobbyKiosk publishes the 飛行開始 button centre (world). */
export function publishKioskButton(pos: number[] | null): void { kioskBtn = pos }
let panelInfo: { buttons: Array<{ name: string; pos: number[] }>; log: string[] } | null = null
/** SessionPanel publishes its buttons' world centres and the console lines it shows. */
export function publishPanel(p: { buttons: Array<{ name: string; pos: number[] }>; log: string[] } | null): void { panelInfo = p }
let previewInfo: { air: string; pos: number[]; radius: number } | null = null
/** LobbyKiosk publishes the showroom preview: which aircraft, where (world), and the radius the engine reported. */
export function publishPreview(p: { air: string; pos: number[]; radius: number } | null): void { previewInfo = p }
let kioskItems: Array<{ name: string; pos: number[] }> = []
/** LobbyKiosk publishes the world centres of its field-column items (current page). */
export function publishKioskItems(items: Array<{ name: string; pos: number[] }>): void { kioskItems = items }
let fieldNames: string[] = []
/** LobbyKiosk publishes the engine's field list once read. */
export function publishFields(names: string[]): void { fieldNames = names }
let apronInfo: { spawn: number[]; dir: number[]; elev: number; stp: string } | null = null
/** Airfield publishes where it put the apron (world) for the current field. */
export function publishApron(a: { spawn: number[]; dir: number[]; elev: number; stp: string } | null): void { apronInfo = a }

export function StateBeacon({ role, room, field }: { role: NetRole | null; room: string | null; field: string | null }) {
  const mod = useEngine()
  const gl = useThree((s) => s.gl)
  const users = useUsers() as unknown as { getLocalMovement?: () => { position?: unknown } | null }
  const camera = useThree((s) => s.camera)
  const acc = useRef(0)
  const v = useRef(new Vector3())
  const feetTmp = useRef(new Vector3())
  const q = useRef(new Quaternion())
  const net = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  useFrame((_s, dt) => {
    acc.current += dt
    if (acc.current < 0.1) return // 10 Hz: fast enough for closed-loop aiming in tests
    acc.current = 0
    const cam = gl.xr?.isPresenting ? gl.xr.getCamera() : camera
    cam.matrixWorld.decompose(v.current, q.current, new Vector3())
    // Feet from the host's movement (array or {x,y,z}); terrain under them from the engine's probe.
    const fv = readFeet(users, feetTmp.current) // what the seat sees (incl. the dev stand-in's delay)
    const feet: number[] | null = fv ? fv.toArray() : null
    // The surface under the local player, as the engine answered GroundPatch's probe.
    const fieldElev: number | null = groundUnder && !probeBusy ? groundUnder.height : null
    const detail: YsfxBeacon = {
      t: Date.now(), role, room, net: null, flight: null, aircraft: [], hud: hudLines, seat: localSeat, draws: ysfxStats.draws, bg: ysfxStats.bgTicks, ctl: null, lobby: lobbyCounts ? [...lobbyCounts, kioskClicks(), kioskJoinPending() ? 1 : 0] : null, kiosk: kioskHovers(),
      ground: { cam: v.current.y, feet, field: fieldElev, deck: !!groundUnder?.deck },
      vr: { ...saccStatus, right: { ...saccStatus.right }, left: { ...saccStatus.left } },
      eye: eyeCalibration(),
      lag: seatLag(),
      load: loadState(),
      console: consoleButtons,
      mouse: { ...mouseStick },
      gates: { coarse: isCoarsePointer(), xr: !!gl.xr?.isPresenting },
      cam: { pos: v.current.toArray(), quat: q.current.toArray() },
      keys: { n: ysfxStats.keys, last: ysfxStats.lastKey },
      cockpit: cockpitWorld,
      field: { current: field, names: fieldNames },
      apron: apronInfo,
      kioskBtn,
      kioskItems,
      panel: panelInfo,
      preview: previewInfo,
      gfx: { vp: ysfxStats.lastVp, eye: ysfxStats.lastEye, rt: ysfxStats.rt, fb: ysfxStats.fb, buf: ysfxStats.buf },
    }
    if (mod) {
      detail.net = { ...readNetState(mod, net.current) }
      const f = mod.HEAPF32
      const d = mod._FsVrFlightDataPointer() >> 2
      detail.flight = Array.from(f.subarray(d, d + 16))
      const c = mod._FsVrControlDataPointer() >> 2
      detail.ctl = Array.from(f.subarray(c, c + 12))
      detail.ctlOwner = controlBus.owner()
      detail.engine = engineBuildId()
      detail.view = f[(mod._FsVrExternalViewDataPointer() >> 2) + 3]
      const n = airCount(mod)
      for (let i = 0; i < n; i++) {
        const b = airBase(mod, i)
        detail.aircraft.push({ id: f[b], alive: f[b + 1] !== 0, player: f[b + 2] !== 0, name: airName(mod, i), pos: [f[b + 15], f[b + 16], f[b + 17]] })
      }
    }
    window.dispatchEvent(new CustomEvent('ysfx-state', { detail }))
  })
  return null
}
