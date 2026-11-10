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
  /** Join requests the server rejected (client mode; counts up). */
  rejected: number
  /** Mission the server runs (server mode): 0 none, 1 intercept, 2 endurance, 3 close air support. */
  mission?: number
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
  out.rejected = f[p + 8]
  out.mission = f[p + 9]
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

/** Lobby commands of fsvr.h FsVrNetRequestCommand. */
export const NET_CMD = {
  LOSS_REPORT: 1, KILL_REPORT: 2,
  INTERCEPT: 10, ENDURANCE_JET: 11, ENDURANCE_WW2: 12, CLOSE_AIR_SUPPORT: 13, TERMINATE_MISSION: 14, REVIVE_GROUND: 15,
} as const
export function requestCommand(m: YsflightModule, cmd: number): void {
  m._FsVrNetRequestCommand(cmd)
}
/** The newest `n` lines of the engine console, oldest first. */
export function consoleTail(m: YsflightModule, n: number): string[] {
  const out: string[] = []
  for (let i = Math.min(n, m._FsVrConsoleSeq()) - 1; i >= 0; i--) out.push(m.UTF8ToString(m._FsVrConsoleLine(i)).trimEnd())
  return out
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
/** Start position coordinates (three.js world, same frame as the aircraft list). */
export function lobbyStpPositions(m: YsflightModule): number[][] {
  const n = m._FsVrLobbyStpCount()
  return Array.from({ length: n }, (_, i) => {
    const b = m._FsVrLobbyStpPos(i) >> 2
    return [m.HEAPF32[b], m.HEAPF32[b + 1], m.HEAPF32[b + 2]]
  })
}
/** Start position headings (radians, the engine's YsAtt3 h). */
export function lobbyStpHeadings(m: YsflightModule): number[] {
  const n = m._FsVrLobbyStpCount()
  return Array.from({ length: n }, (_, i) => m._FsVrLobbyStpHeading(i))
}
/** Every field template the engine knows (identifiers for -server / the host's chooser). */
export function lobbyFieldNames(m: YsflightModule): string[] {
  const n = m._FsVrLobbyFieldCount()
  return Array.from({ length: n }, (_, i) => m.UTF8ToString(m._FsVrLobbyFieldName(i)))
}
/** Start positions of the loaded field (names for requestJoin). */
export function lobbyStpNames(m: YsflightModule): string[] {
  const n = m._FsVrLobbyStpCount()
  return Array.from({ length: n }, (_, i) => m.UTF8ToString(m._FsVrLobbyStpName(i)))
}
