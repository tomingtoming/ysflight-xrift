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
