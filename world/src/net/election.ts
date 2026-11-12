/**
 * Who runs the server -- the rules, without React.
 *
 * The host is one visitor's browser (toming's call, 2026-11-08).  Which one
 * matters: everybody's session runs through it, at its frame rate, and stops
 * when it stops.  A headset that is taken off, or a phone whose browser goes
 * to the background, holds everyone up without leaving the instance (toming,
 * 2026-11-12: "would a Quest as the server be a nuisance to everyone?").  So:
 *
 *  1. Vacant seat: desktops claim before phones, phones before headsets.
 *     Nobody knows the others' devices, so the order is made of time: each
 *     class waits longer before it claims, and within a class the lower user
 *     id goes first.  Whoever is alone still becomes the host, a little later.
 *  2. Stalled host: the host counts a heartbeat into the shared state while
 *     its engine steps.  A client that has seen no beat for STALL_MS takes
 *     the seat, in the same order.  The old host, once awake, finds itself a
 *     client.
 *  3. Better host: a visitor with a better device than the host's takes the
 *     seat once nobody has had an aircraft out for a while -- a takeover
 *     restarts every engine, so not over anyone's flight.
 *
 * Every claim is re-checked against the synced state at the moment it is
 * written (mayClaim on the functional update's `prev`).
 */

export const CLASS_DESKTOP = 0
export const CLASS_PHONE = 1
export const CLASS_HEADSET = 2

export interface ElectionState {
  hostId: string | null
  hostNonce?: string
  /** Device class of the host (CLASS_*); absent on a host from before this rule. */
  hostClass?: number
  /** Counts up while the host's engine steps; absent on a host from before this rule. */
  beat?: number
}

/** The host writes a beat this often. */
export const BEAT_MS = 5_000
/** No beat for this long: the host is taken to be stalled (four beats missed). */
export const STALL_MS = 20_000
/** Nobody has had an aircraft out for this long: a better device may take the seat. */
export const UPGRADE_IDLE_MS = 15_000
const FIRST_CLAIM_MS = 2_500 // a newcomer may see an empty user list for a moment
const CLASS_STEP_MS = 2_500 // a headset alone waits 7.5 s for the seat instead of 2.5: the price of not knowing who else is there
const RANK_STEP_MS = 500
const RANK_CAP = 4 // keeps a class inside its own window: 4 * 500 < 2500

export function deviceClass(userAgent: string, coarsePointer: boolean): number {
  if (/OculusBrowser|Quest|Pico|Wolvic|VisionOS/i.test(userAgent)) return CLASS_HEADSET
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) || coarsePointer) return CLASS_PHONE
  return CLASS_DESKTOP
}

/** How long a visitor waits before claiming an open seat: by device class, then by id order among those present. */
export function claimDelayMs(cls: number, rank: number): number {
  return FIRST_CLAIM_MS + Math.max(0, cls) * CLASS_STEP_MS + Math.min(Math.max(0, rank), RANK_CAP) * RANK_STEP_MS
}

export interface View {
  now: number
  me: { id: string; cls: number }
  /** Ids in the instance, the local one included. */
  present: string[]
  state: ElectionState
  /** Since when the seat has been vacant as seen here (null: it is held). */
  vacantSince: number | null
  /** When the beat (or the host) last changed as seen here. */
  beatSeenAt: number
  /** Since when no aircraft has been alive in the local engine, connected and ready (null: someone flies, or unknown). */
  idleSince: number | null
}

export type Reason = 'vacant' | 'stalled' | 'better'

const rankOf = (id: string, among: string[]) => Math.max(0, [...among].sort().indexOf(id))

/** Should this visitor claim the seat now, and why. */
export function decide(v: View): Reason | null {
  const { state, me, present, now } = v
  const held = state.hostId !== null && present.includes(state.hostId)
  if (!held) {
    return v.vacantSince !== null && now - v.vacantSince >= claimDelayMs(me.cls, rankOf(me.id, present)) ? 'vacant' : null
  }
  if (state.hostId === me.id) return null // one's own seat (another tab of the same account is told apart by the nonce, in NetSession)
  const others = present.filter((id) => id !== state.hostId)
  if (state.beat !== undefined && now - v.beatSeenAt >= STALL_MS + claimDelayMs(me.cls, rankOf(me.id, others))) return 'stalled'
  if (state.hostClass !== undefined && me.cls < state.hostClass && v.idleSince !== null &&
      now - v.idleSince >= UPGRADE_IDLE_MS + rankOf(me.id, others) * RANK_STEP_MS) return 'better'
  return null
}

/** The last check, against the synced state as it is when the claim is written. */
export function mayClaim(reason: Reason, prev: ElectionState, me: { id: string; cls: number }, present: string[], beatSeen: number | undefined): boolean {
  const held = prev.hostId !== null && present.includes(prev.hostId)
  if (reason === 'vacant') return !held
  if (!held || prev.hostId === me.id) return false
  if (reason === 'stalled') return prev.beat === beatSeen // still the beat that went stale
  return prev.hostClass !== undefined && me.cls < prev.hostClass
}
