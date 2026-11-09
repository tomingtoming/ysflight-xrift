/**
 * Readers for the engine's network-session blocks (fsvr.h, ysflight-xrift
 * fork): the session state and the all-aircraft pose list.  Plain functions
 * over HEAPF32 so useFrame callers pay nothing per frame.
 */
import type { YsflightModule } from '../engine/types'

export const NET_MODE_NONE = 0
export const NET_MODE_SERVER = 1
export const NET_MODE_CLIENT = 2

export const NET_STANDBY = 0
export const NET_FLYING = 1

export interface NetState {
  mode: number
  ready: boolean
  state: number
  waiting: boolean
  playerAirId: number
  connected: number
  runState: number
  fatal: number
}

export function readNetState(m: YsflightModule, out: NetState): NetState {
  const p = m._FsVrNetStateDataPointer() >> 2
  const f = m.HEAPF32
  out.mode = f[p]
  out.ready = f[p + 1] !== 0
  out.state = f[p + 2]
  out.waiting = f[p + 3] !== 0
  out.playerAirId = f[p + 4]
  out.connected = f[p + 5]
  out.runState = f[p + 6]
  out.fatal = f[p + 7]
  return out
}

export const AIR_STRIDE = 24

/** Number of aircraft in the list this frame. */
export function airCount(m: YsflightModule): number {
  return m.HEAPF32[m._FsVrAirListDataPointer() >> 2]
}

/** HEAPF32 index of entry i (its [0] = search key). */
export function airBase(m: YsflightModule, i: number): number {
  return (m._FsVrAirListDataPointer() >> 2) + 1 + i * AIR_STRIDE
}

export function airName(m: YsflightModule, i: number): string {
  return m.UTF8ToString(m._FsVrAirListName(i))
}

export function airIdentifier(m: YsflightModule, i: number): string {
  return m.UTF8ToString(m._FsVrAirListIdentifier(i))
}

/** Index of the alive aircraft flown by `pilot` (engine player name), or -1. */
export function findAircraftByPilot(m: YsflightModule, pilot: string): number {
  const n = airCount(m)
  for (let i = 0; i < n; i++) {
    const b = airBase(m, i)
    if (m.HEAPF32[b + 1] !== 0 && airName(m, i) === pilot) return i
  }
  return -1
}

export function requestJoin(m: YsflightModule, air: string, stp: string, iff = -1): void {
  m.ccall('FsVrNetRequestJoin', null, ['string', 'string', 'number'], [air, stp, iff])
}

export function requestLeave(m: YsflightModule): void {
  m._FsVrNetRequestLeave()
}

/**
 * The engine player name for an XRift user.  Deterministic from the user id
 * so every client can map an aircraft (the sim carries the pilot name) back
 * to the XRift user flying it without any extra sync channel.
 */
export function pilotNameOf(user: { id: string; displayName: string }): string {
  const base = user.displayName.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'pilot'
  return `${base}_${user.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 6)}`
}

/** Aircraft templates offered by the lobby (identifiers for requestJoin). */
export function lobbyAirNames(m: YsflightModule): string[] {
  const n = m._FsVrLobbyAirCount()
  return Array.from({ length: n }, (_, i) => m.UTF8ToString(m._FsVrLobbyAirName(i)))
}
/** Start positions of the loaded field (names for requestJoin). */
export function lobbyStpNames(m: YsflightModule): string[] {
  const n = m._FsVrLobbyStpCount()
  return Array.from({ length: n }, (_, i) => m.UTF8ToString(m._FsVrLobbyStpName(i)))
}
