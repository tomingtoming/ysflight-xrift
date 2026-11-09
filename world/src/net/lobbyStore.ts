/**
 * Lobby selection shared between the kiosk (where the player picks) and the
 * cockpit seat (which boards the player once the aircraft exists).
 */
let pending = false
export function setKioskJoin(v: boolean): void { pending = v }
export function kioskJoinPending(): boolean { return pending }
