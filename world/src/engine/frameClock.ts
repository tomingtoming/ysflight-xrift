/**
 * frameClock — one timestamp per displayed frame, shared by everything that
 * integrates or samples over time (the engine's simulation step, the seat's
 * lag measurement, the pose history).
 *
 * Each of them used to read the wall clock at the moment it ran.  A callback
 * runs somewhere inside the frame, not at a fixed phase of it, so those
 * readings wobble by about a millisecond against the display's even cadence:
 * 6.7 cm of aircraft travel per frame at 56 m/s on the production host
 * (2026-11-10), and each consumer wobbled differently.
 *
 * The frame's own timestamp is even: the vsync-aligned time every
 * requestAnimationFrame callback of the frame receives
 * (`document.timeline.currentTime` is that same value, without needing a
 * second rAF loop), or in an XR session the frame's predicted display time.
 * The first caller in a frame (the engine step, priority -3) ticks the clock;
 * the rest read it.
 */
export const frameClock = {
  /** This frame's timestamp, ms (time origin = page time origin). */
  nowMs: 0,
  /** Seconds since the previous frame's timestamp (0 on the first frame). */
  dt: 0,
  /** Frame counter: lets per-frame consumers tell a new frame from a repeat call. */
  frame: 0,
}

/** Advance to this frame.  Call once per frame, first thing. */
export function tickFrameClock(presenting: boolean, xrFrame?: unknown): void {
  let t = -1
  if (presenting) {
    const p = (xrFrame as { predictedDisplayTime?: number } | undefined)?.predictedDisplayTime
    if (typeof p === 'number' && p > 0) t = p
  } else if (typeof document !== 'undefined') {
    const c = document.timeline?.currentTime
    if (typeof c === 'number' && c > 0) t = c
  }
  if (t < 0) t = performance.now()
  const prev = frameClock.nowMs
  // A source switch (entering/leaving XR) or a repeated timestamp must not step time backwards.
  frameClock.dt = frameClock.frame === 0 ? 0 : Math.max(0, (t - prev) / 1000)
  frameClock.nowMs = Math.max(prev, t)
  frameClock.frame++
}
