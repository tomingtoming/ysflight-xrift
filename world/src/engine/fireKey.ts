/**
 * fireKey — the engine's fire key (Space, FIREWEAPON in the key table) held
 * by whichever input asks for it.
 *
 * The keyboard's Space never reaches the engine: it is the host's "stand up"
 * key (YsflightEngine.tsx).  So a desktop pilot fires with Shift or the
 * right mouse button, a gamepad with A -- and two of them may be down at
 * once.  The key goes down with the first holder and up with the last.
 */
import type { YsflightModule } from './types'

const holders = new Set<string>()
export const fireStatus = { held: false, presses: 0 }

export function setFire(mod: YsflightModule | null, source: string, on: boolean): void {
  const was = holders.size > 0
  if (on) holders.add(source); else holders.delete(source)
  const now = holders.size > 0
  if (now === was) return
  fireStatus.held = now
  if (now) fireStatus.presses++
  mod?.ccall('YsfxKeyByCode', 'number', ['string', 'number'], ['Space', now ? 1 : 0])
}

/** Everybody lets go (the pilot left the seat, the window lost focus, a new engine). */
export function releaseFire(mod: YsflightModule | null): void {
  if (holders.size === 0) return
  holders.clear()
  fireStatus.held = false
  mod?.ccall('YsfxKeyByCode', 'number', ['string', 'number'], ['Space', 0])
}
