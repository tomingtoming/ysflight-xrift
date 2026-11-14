/**
 * keyStick — the keyboard as the control stick, the way YSFLIGHT itself does
 * it (fscontrol.cpp, FSBTF_AILERONLEFT / FSBTF_ELEVATORUP ...): every key
 * press, auto-repeat included, moves the stick one step and it STAYS there.
 *
 *   roll   0.1 per press; a press against the current side first centres it
 *   pitch  0.04 per press
 *
 * The host's two-axis seat input only knows held / not held, which cannot
 * hold a small deflection; this can.
 *
 * Pure state: the seat feeds it key presses and reads the stick.
 */
const ROLL_STEP = 0.1
const PITCH_STEP = 0.04

export const keyStick = { /** -1..+1, right positive. */ ail: 0, /** -1..+1, nose up positive. */ elv: 0 }

export function resetKeyStick(): void {
  keyStick.ail = 0
  keyStick.elv = 0
}

/** One key press (KeyboardEvent.code).  Returns whether it was a stick key. */
export function keyStickPress(code: string): boolean {
  switch (code) {
    case 'ArrowRight': keyStick.ail = keyStick.ail < 0 ? 0 : Math.min(1, keyStick.ail + ROLL_STEP); return true
    case 'ArrowLeft': keyStick.ail = keyStick.ail > 0 ? 0 : Math.max(-1, keyStick.ail - ROLL_STEP); return true
    // Up / W push the stick forward: nose down.
    case 'ArrowUp': case 'KeyW': keyStick.elv = Math.max(-1, keyStick.elv - PITCH_STEP); return true
    case 'ArrowDown': case 'KeyS': keyStick.elv = Math.min(1, keyStick.elv + PITCH_STEP); return true
  }
  return false
}
