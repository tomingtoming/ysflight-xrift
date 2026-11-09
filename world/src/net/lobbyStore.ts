/**
 * Lobby selection shared between the kiosk (where the player picks) and the
 * cockpit seat (which boards the player once the aircraft exists).
 */
let pending = false
export function setKioskJoin(v: boolean): void { pending = v }
export function kioskJoinPending(): boolean { return pending }

/** 飛行開始 presses seen by the kiosk (also when it could not start): a
 *  harness counter to tell "click never arrived" from "engine refused". */
let clicks = 0
export function countKioskClick(): void { clicks++ }
export function kioskClicks(): number { return clicks }

/** Pointer hovers over the kiosk's 飛行開始 button and the last pointer type
 *  seen (mouse / touch / xr ray...): tells which input paths reach uikit. */
const ev: Record<string, number> = { enter: 0, leave: 0, down: 0, up: 0, click: 0 }
let lastPointer = ''
export function noteKioskPointer(kind: 'enter' | 'leave' | 'down' | 'up' | 'click', pointerType: string): void { ev[kind]++; lastPointer = `${kind}:${pointerType}` }
export function kioskHovers(): { hovers: number; lastPointer: string; ev: Record<string, number> } { return { hovers: ev.enter, lastPointer, ev: { ...ev } } }

/**
 * A kiosk start requested while the player's previous aircraft still stood:
 * the engine must let that one go first; LobbyKiosk's frame loop joins once
 * it is back in standby.  Shared so the dev hook can start the same way.
 */
let pendingJoinReq: { air: string; stp: string } | null = null
export function setPendingJoin(j: { air: string; stp: string } | null): void { pendingJoinReq = j }
export function pendingJoin(): { air: string; stp: string } | null { return pendingJoinReq }

