/**
 * NetSession — one XRift instance = one YSFLIGHT network session.
 *
 * Host election (toming's call, 2026-11-08): the first browser in the
 * instance runs the engine in -server mode and registers a signaling room;
 * everyone else boots -client against that room.  When the host leaves the
 * instance a remaining user claims the room with a fresh code and every
 * engine restarts in its new role.  The election lives in XRift instance
 * state ('ysfx-net'), so no extra service is needed to agree on the host.
 */
import { useInstanceState, useUsers } from '@xrift/world-components'
import { useEffect, useMemo, useState } from 'react'
import { YsflightEngine } from '../engine/YsflightEngine'
import { pilotNameOf } from './netState'
import { StateBeacon } from './StateBeacon'

export interface NetSessionState {
  hostId: string | null
  /** Per-tab nonce of the host: the same account in two tabs shares an id,
   *  and only the tab that claimed may run the server (measured 2026-11-09:
   *  without it both tabs booted -server on the same room). */
  hostNonce?: string
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

  const me = localUser ?? { id: 'local', displayName: 'pilot' }
  const pilotName = useMemo(() => pilotNameOf(me), [me.id, me.displayName]) // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the host seat when nobody present holds it.  A newcomer may see an
  // empty user list for a moment, so wait before claiming and re-check the
  // synced state at claim time (functional update).
  useEffect(() => {
    const present = new Set([me.id, ...remoteUsers.map((u) => u.id)])
    const hostAlive = net.hostId !== null && present.has(net.hostId)
    if (hostAlive) return
    const candidates = [...present].sort()
    if (candidates[0] !== me.id) return // lowest id among those present claims; the rest wait
    const timer = setTimeout(() => {
      setNet((prev) => {
        if (prev.hostId !== null && present.has(prev.hostId)) return prev
        return { hostId: me.id, hostNonce: nonce, room: makeRoom(), since: Date.now() }
      })
    }, 2500)
    return () => clearTimeout(timer)
  }, [net.hostId, me.id, nonce, remoteUsers, setNet])

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
  if (!role || !room) return <StateBeacon role={null} room={null} field={null} /> // election pending: nothing to boot yet

  const field = (forced ? devField : net.field) ?? FIELD
  const setField = role === 'host' ? (f: string) => { if (forced) setDevField(f); else setNet((prev) => ({ ...prev, field: f })) } : undefined
  // The engine key carries the field: the server restarts on the new field
  // and every client restarts to reconnect to it.
  const args = role === 'host' ? ['-server', pilotName, field] : ['-client', pilotName, room]
  return (
    <>
      <YsflightEngine key={`${role}:${room}:${field}`} args={args} signalUrl={SIGNAL_URL} roomCode={room} />
      <StateBeacon role={role} room={room} field={field} />
      {children?.(role, pilotName, room, field, setField)}
    </>
  )
}
