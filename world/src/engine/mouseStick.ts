/**
 * mouseStick — the mouse as the control stick while the left button is held.
 *
 * YSFLIGHT's own mouse mode reads the cursor's offset from the window
 * centre; under XRift the pointer is locked and the mouse is the player's
 * look, so there is no cursor and no centre.  Instead the stick follows the
 * VR grab grammar: press the left button to take the stick, the mouse's
 * movement since the grab is the deflection (250 px = full), release and
 * the stick springs back to centre and the mouse is the look again.  While
 * grabbed the movement is kept from the host (stopPropagation in the window
 * capture phase runs before the host's document listener), so the view
 * stays put.
 *
 * Installed at module load like keyBridge; the seats enable it while the
 * local player flies on a fine-pointer device outside XR.
 */
const FULL_PX = 250

export const mouseStick = {
  enabled: false,
  grabbed: false,
  /** -1..+1, right positive. */
  ail: 0,
  /** -1..+1, nose up positive (mouse pushed away = stick forward = negative). */
  elv: 0,
  grabs: 0,
}

let accX = 0
let accY = 0
let installed = false

export function setMouseStickEnabled(on: boolean): void {
  if (mouseStick.enabled === on) return
  mouseStick.enabled = on
  if (!on) release()
}

function release(): void {
  mouseStick.grabbed = false
  mouseStick.ail = 0
  mouseStick.elv = 0
  accX = 0
  accY = 0
}

export function installMouseStick(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  const opts = { capture: true }
  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !mouseStick.enabled) return
    accX = 0
    accY = 0
    mouseStick.grabbed = true
    mouseStick.grabs++
  }, opts)
  window.addEventListener('mousemove', (e) => {
    if (!mouseStick.grabbed) return
    accX += e.movementX
    accY += e.movementY
    mouseStick.ail = Math.max(-1, Math.min(1, accX / FULL_PX))
    mouseStick.elv = Math.max(-1, Math.min(1, accY / FULL_PX))
    e.stopPropagation() // the host must not turn this into a look
  }, opts)
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0 && mouseStick.grabbed) release()
  }, opts)
  window.addEventListener('blur', release)
}

installMouseStick()
