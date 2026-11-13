/**
 * NetSession — one XRift instance = one YSFLIGHT network session.
 *
 * Host election (toming's call, 2026-11-08): one browser in the instance
 * runs the engine in -server mode and registers a signaling room; everyone
 * else boots -client against that room.  When the host leaves the instance,
 * stalls, or a better device can take over an idle session, a remaining
 * user claims the room with a fresh code and every engine restarts in its
 * new role (the rules: election.ts).  The election lives in XRift instance
 * state ('ysfx-net'), so no extra service is needed to agree on the host.
 */
import { useInstanceState, useUsers } from '@xrift/world-components'
import { useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEngine } from '../engine/engineStore'
import { YsflightEngine } from '../engine/YsflightEngine'
import { airBase, airCount, airName, pilotNameOf, readNetState, type NetState } from './netState'
import { BEAT_MS, decide, deviceClass, mayClaim, type Reason } from './election'
import { ysfxStats } from '../engine/YsflightEngine'
import { isCoarsePointer } from './TouchConsole'
import { StateBeacon } from './StateBeacon'
import { setConnectStatus, setSessionRole } from './roleStore'

export interface NetSessionState {
  hostId: string | null
  /** Per-tab nonce of the host: the same account in two tabs shares an id,
   *  and only the tab that claimed may run the server (measured 2026-11-09:
   *  without it both tabs booted -server on the same room). */
  hostNonce?: string
  /** Device class of the host and its heartbeat (election.ts). */
  hostClass?: number
  beat?: number
  room: string | null
  since: number
  /** The field (airfield) the session flies; only the host writes it, every engine restarts on a change. */
  field?: string
}

export const FIELD = 'ATSUGI_AIRBASE'

const SIGNAL_URL =
  (import.meta.env.VITE_YSFX_SIGNAL_URL as string | undefined) ||
  'wss://ysflight-xrift-signal.toming.workers.dev/signal'

function makeRoom(): string {
  // 8-digit numeric, the shape the signaling hub and yssocket expect.
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('')
}

export type NetRole = 'host' | 'client'

const CLIENT_STALL_S = 30
const CLIENT_MAX_RETRIES = 5
/** Dev aid: ?ysfxstall=<s> shortens the watchdog so a test can reach the give-up. */
const stallSeconds = (): number => {
  const q = import.meta.env.DEV ? /[?&]ysfxstall=(\d+)/.exec(location.search) : null
  return q ? Number(q[1]) : CLIENT_STALL_S
}

/**
 * A client whose WebRTC join never completes just sits there: the engine
 * prints "Joining WebRTC room ..." and nothing follows, no error either
 * (seen twice on the production host, 2026-11-10; the visitor would look at
 * the loading panel for good).  The cause is not known.  If the session is
 * not ready this long after the engine came up, boot the engine again.
 */
function ClientWatchdog({ onStall, stallS }: { onStall: () => void; stallS: number }) {
  const mod = useEngine()
  const waited = useRef(0)
  const done = useRef(false)
  const ns = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  useEffect(() => { waited.current = 0; done.current = false }, [mod])
  useFrame((_s, dt) => {
    if (!mod || done.current) return
    if (readNetState(mod, ns.current).ready) { done.current = true; return }
    waited.current += Math.min(dt, 0.1)
    if (waited.current > stallS) { done.current = true; onStall() }
  })
  return null
}

/**
 * Since when nobody has had an aircraft out, as this client's engine sees it
 * (connected and ready): what a better device waits for before it takes the
 * host seat (election.ts).  null while anyone flies or the engine cannot tell.
 */
function IdleWatch({ idleSince }: { idleSince: React.MutableRefObject<number | null> }) {
  const mod = useEngine()
  const ns = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  const acc = useRef(0)
  useEffect(() => { idleSince.current = null; return () => { idleSince.current = null } }, [mod, idleSince])
  useFrame((_s, dt) => {
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    let idle = false
    if (mod && readNetState(mod, ns.current).ready) {
      idle = true
      const n = airCount(mod)
      // Pilots carry a name; a field's own traffic and mission aircraft do not, and nobody loses a flight when those restart.
      for (let i = 0; i < n; i++) if (mod.HEAPF32[airBase(mod, i) + 1] !== 0 && airName(mod, i) !== '') { idle = false; break }
    }
    if (!idle) idleSince.current = null
    else if (idleSince.current === null) idleSince.current = Date.now()
  })
  return null
}

export interface NetSessionProps {
  /** `setField` is defined for the host only (toming's call, 2026-11-09: the host alone may change the map). */
  children?: (role: NetRole, pilotName: string, room: string | null, field: string, setField: ((field: string) => void) | undefined) => React.ReactNode
}

export function NetSession({ children }: NetSessionProps) {
  const { localUser, remoteUsers } = useUsers()
  const [net, setNet] = useInstanceState<NetSessionState>('ysfx-net', { hostId: null, room: null, since: 0 })
  const nonce = useMemo(() => Math.random().toString(36).slice(2, 10), [])
  // Dev environment: instance state is not shared/updated there, so the forced
  // host keeps the field locally (the production path is the instance state).
  const [devField, setDevField] = useState<string | undefined>(undefined)
  const [retry, setRetry] = useState(0)
  /** The client gave up on this room (every restart stalled): the loading panel says so instead of waiting for good. */
  const [failedRoom, setFailedRoom] = useState<string | null>(null)
  /** retry at the moment this room was first seen: the attempts count per host, not per visit. */
  const roomStart = useRef<{ room: string | null; retry: number }>({ room: null, retry: 0 })

  const me = localUser ?? { id: 'local', displayName: 'pilot' }
  const pilotName = useMemo(() => pilotNameOf(me), [me.id, me.displayName]) // eslint-disable-line react-hooks/exhaustive-deps

  // The host seat: who claims it and when is election.ts (desktops before
  // phones before headsets; a stalled host is replaced; a better device takes
  // over an idle session).  Looked at twice a second, on refs, so a re-render
  // neither delays nor repeats a claim.
  const myClass = useMemo(() => {
    const q = import.meta.env.DEV ? /[?&]ysfxclass=(\d)/.exec(location.search) : null
    return q ? Number(q[1]) : deviceClass(navigator.userAgent, isCoarsePointer())
  }, [])
  const view = useRef({ net, present: [me.id], vacantSince: null as number | null, beatSeenAt: Date.now(), beatKey: '' })
  const idleSince = useRef<number | null>(null)
  view.current.net = net
  view.current.present = [me.id, ...remoteUsers.map((u) => u.id)]
  useEffect(() => {
    const tick = () => {
      const v = view.current
      const now = Date.now()
      const held = v.net.hostId !== null && v.present.includes(v.net.hostId)
      if (held) v.vacantSince = null
      else if (v.vacantSince === null) v.vacantSince = now
      const key = `${v.net.hostId}:${v.net.hostNonce}:${v.net.beat}`
      if (key !== v.beatKey) { v.beatKey = key; v.beatSeenAt = now }
      const mine = { id: me.id, cls: myClass }
      const reason: Reason | null = decide({ now, me: mine, present: v.present, state: v.net, vacantSince: v.vacantSince, beatSeenAt: v.beatSeenAt, idleSince: idleSince.current })
      if (!reason) return
      const present = v.present, beatSeen = v.net.beat
      console.info(`[ysf] claiming the host seat (${reason}); device class ${myClass}, host was ${v.net.hostId ?? 'nobody'} (class ${v.net.hostClass ?? '?'})`)
      v.beatSeenAt = now // one claim per stale beat; the synced state decides the rest
      setNet((prev) => (mayClaim(reason, prev, mine, present, beatSeen)
        ? { ...prev, hostId: me.id, hostNonce: nonce, hostClass: myClass, beat: 0, room: makeRoom(), since: Date.now() }
        : prev))
    }
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [me.id, myClass, nonce, setNet])

  // The host's heartbeat: counted into the shared state while its engine
  // steps (frame loop or background ticker).  A host whose browser sleeps
  // stops counting, and a client takes the seat (election.ts, STALL_MS).
  const isHostHere = net.hostId === me.id && (net.hostNonce === undefined || net.hostNonce === nonce)
  useEffect(() => {
    if (!isHostHere) return
    let seen = -1
    const id = setInterval(() => {
      if (ysfxStats.steps === seen) return
      seen = ysfxStats.steps
      setNet((prev) => (prev.hostId === me.id && prev.hostNonce === nonce ? { ...prev, hostClass: myClass, beat: (prev.beat ?? 0) + 1 } : prev))
    }, BEAT_MS)
    return () => clearInterval(id)
  }, [isHostHere, me.id, myClass, nonce, setNet])

  // Dev aid: ?ysfxnet=host:12345678 / client:12345678 forces the role and room
  // (two tabs of the dev environment do not share instance state).
  let role: NetRole | null = null
  let room = net.room
  const forced = import.meta.env.DEV ? /[?&]ysfxnet=(host|client):(\d{8})/.exec(location.search) : null
  if (forced) {
    role = forced[1] as NetRole
    room = forced[2]
  } else if (net.hostId && net.room) {
    role = net.hostId === me.id && (net.hostNonce === undefined || net.hostNonce === nonce) ? 'host' : 'client'
  }
  const hostUser = net.hostId === me.id ? me : remoteUsers.find((u) => u.id === net.hostId)
  setSessionRole(role, forced && role === 'host' ? me.displayName : (hostUser?.displayName ?? ''))
  const field = (forced ? devField : net.field) ?? FIELD
  const isForced = !!forced
  const hostSetField = useCallback((f: string) => { if (isForced) setDevField(f); else setNet((prev) => ({ ...prev, field: f })) }, [isForced, setNet])
  const setField = role === 'host' ? hostSetField : undefined
  // The world below is the same element until one of these changes: the
  // host's heartbeat lands in the instance state every few seconds and
  // re-renders this component, and must not re-render the airfield with it
  // (a hitch every five seconds, for everyone, in the middle of a flight).
  const session = useMemo(() => (role && room ? children?.(role, pilotName, room, field, setField) : null), [children, role, pilotName, room, field, setField])
  const args = useMemo(() => (role === 'host' ? ['-server', pilotName, field] : ['-client', pilotName, room ?? '']), [role, pilotName, field, room])
  if (roomStart.current.room !== room) roomStart.current = { room, retry }
  const tries = retry - roomStart.current.retry
  const failed = role === 'client' && room !== null && failedRoom === room
  setConnectStatus(role === 'client' ? { tries, max: CLIENT_MAX_RETRIES, failed } : null)
  const stallS = useMemo(stallSeconds, [])
  const onStall = useCallback(() => {
    if (tries + 1 >= CLIENT_MAX_RETRIES) {
      // Every restart stalled the same way: say so (LoadingPanel) rather than restart for good.
      console.warn(`[ysf] client not connected after ${CLIENT_MAX_RETRIES} attempts: giving up on room ${room}`)
      setFailedRoom(room)
      return
    }
    console.warn(`[ysf] client not connected after ${stallS} s: restarting the engine`)
    setRetry((r) => r + 1)
  }, [tries, room, stallS])
  const engine = useMemo(() => (role && room ? <YsflightEngine key={`${role}:${room}:${field}:${retry}`} args={args} signalUrl={SIGNAL_URL} roomCode={room} /> : null), [role, room, field, retry, args])
  if (!role || !room) return <StateBeacon role={null} room={null} field={null} /> // election pending: nothing to boot yet

  // The engine key carries the field: the server restarts on the new field
  // and every client restarts to reconnect to it.
  return (
    <>
      {engine}
      {role === 'client' && !failed ? <ClientWatchdog onStall={onStall} stallS={stallS} /> : null}
      {role === 'client' ? <IdleWatch idleSince={idleSince} /> : null}
      <StateBeacon role={role} room={room} field={field} election={{ cls: myClass, hostId: net.hostId, hostClass: net.hostClass, beat: net.beat }} />
      {session}
    </>
  )
}
