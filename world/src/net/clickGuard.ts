/**
 * clickGuard — the click that takes the mouse lock is not a click on the world.
 *
 * On a desktop the host asks for a click to lock the mouse, and passes that
 * same click to whatever the crosshair rests on.  A visitor who arrives
 * facing the kiosk would pick a list row with it (production, 2026-11-11:
 * the row was ON_CARRIER2, and the next flight began on a carrier).  So a
 * crosshair click counts only when the mouse was already locked as the
 * button went down.  Touch, the phone's interact button and VR rays have no
 * mouse lock and are let through.
 */
let lockedAtDown = false
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => { lockedAtDown = !!document.pointerLockElement }, true)
}

const pointerType = (e: unknown) => String((e as { pointerType?: string })?.pointerType ?? (e as { nativeEvent?: { pointerType?: string } })?.nativeEvent?.pointerType ?? '?')

/** True when this click is a deliberate one (see above). */
export function deliberate(e: unknown): boolean {
  // Before the lock the same click arrives as a plain mouse pointer at the screen centre.
  const t = pointerType(e)
  if (t !== 'camera-ray' && t !== 'mouse') return true
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return true
  return lockedAtDown
}
