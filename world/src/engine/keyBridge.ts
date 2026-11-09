/**
 * Keyboard bridge installed at module-load time.
 *
 * The XRift dev environment's PhysicsPlayer handles keydown/keyup on
 * `window` in the capture phase and calls stopImmediatePropagation(), so any
 * listener registered after it never fires.  Listeners registered BEFORE it
 * (same target, same phase, earlier registration) still run.  This module is
 * imported before the host mounts (dev.tsx imports it first; the world entry
 * imports it as well), registers once, and fans events out to subscribers.
 */
export type KeyHandler = (e: KeyboardEvent) => void

const held = new Set<string>()
/** Whether a physical key (KeyboardEvent.code) is currently down, from the same capture listener. */
export function isKeyDown(code: string): boolean { return held.has(code) }

const downHandlers = new Set<KeyHandler>()
const upHandlers = new Set<KeyHandler>()
const blurHandlers = new Set<() => void>()
let installed = false

export function installKeyBridge(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const opts = { capture: true }
  window.addEventListener('keydown', (e) => { held.add(e.code); downHandlers.forEach((h) => h(e)) }, opts)
  window.addEventListener('keyup', (e) => { held.delete(e.code); upHandlers.forEach((h) => h(e)) }, opts)
  window.addEventListener('blur', () => { held.clear(); blurHandlers.forEach((h) => h()) })
}

export function subscribeKeys(down: KeyHandler, up: KeyHandler, blur: () => void): () => void {
  installKeyBridge()
  downHandlers.add(down)
  upHandlers.add(up)
  blurHandlers.add(blur)
  return () => {
    downHandlers.delete(down)
    upHandlers.delete(up)
    blurHandlers.delete(blur)
  }
}

installKeyBridge()
