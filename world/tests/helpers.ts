import type { Page } from '@playwright/test'

/**
 * Enter the world on the real host.  A world URL opens the world's detail
 * page (lobby); the world itself runs only inside an instance:
 *   /world/<id>  -> click an instance card (or "新規作成" when none)
 *   /instance/<id> -> "入室する" (needs a microphone: the harness grants a
 *   fake one, see playwright.config.ts)
 * YSFX_INSTANCE_URL skips the lobby.  Returns the instance URL.
 */
export async function enterWorld(page: Page, worldUrl: string): Promise<string> {
  const direct = process.env.YSFX_INSTANCE_URL
  await page.goto(direct || worldUrl)
  // The host may send a world URL straight on to the instance the account
  // was last in (observed right after another session left): whichever
  // appears first decides the path -- an instance card, the empty-state
  // create button, or the instance page's enter button.
  const enterBtn = page.getByRole('button', { name: /入室する/ })
  const card = page.locator('h4').filter({ hasText: '#' }).first()
  const create = page.getByRole('button', { name: /^(➕ )?(新規)?作成$/ }) // "新規作成" with a list, "作成" on the empty-state form
  const first = await Promise.any([
    enterBtn.waitFor({ timeout: 90_000 }).then(() => 'enter'),
    card.waitFor({ timeout: 90_000 }).then(() => 'card'),
    create.waitFor({ timeout: 90_000 }).then(() => 'create'),
  ])
  if (first !== 'enter' && !/\/instance\//.test(page.url())) {
    if (!(await card.count())) {
      await create.click() // creates it and lists it (the card is the way in) -- or goes straight to the instance
      await Promise.any([card.waitFor({ timeout: 30_000 }), page.waitForURL(/\/instance\//, { timeout: 30_000 })])
    }
  }
  if (!/\/instance\//.test(page.url())) {
    // A host modal (class _modal_*, with a close button) sometimes sits over
    // the list -- e.g. right after the same account left another session.
    // Record it, close it, then go in.
    const modal = page.locator('[class*="_modal_"]').first()
    if (await modal.isVisible().catch(() => false)) {
      const text = (await modal.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)
      console.log(`[enterWorld] host modal: ${text}`)
      const close = modal.locator('[class*="_closeButton_"]').first()
      if (await close.count()) await close.click()
      else await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    }
    await card.click()
    await page.waitForURL(/\/instance\//, { timeout: 30_000 })
  }
  await enterBtn.waitFor({ timeout: 60_000 })
  // A new world version asks every visitor to acknowledge its external
  // connections again before 入室する enables.
  const consent = page.getByRole('checkbox').first()
  if (await consent.isVisible().catch(() => false)) await consent.check()
  await enterBtn.click()
  return page.url()
}

/** The world's read-only beacon (src/net/StateBeacon.tsx). */
export interface Beacon {
  t: number
  role: 'host' | 'client' | null
  election?: { cls: number; hostId: string | null; hostClass?: number; beat?: number }
  room: string | null
  net: { mode: number; ready: boolean; state: number; waiting: boolean; playerAirId: number; connected: number; runState: number; fatal: number; rejected: number; mission?: number } | null
  flight: number[] | null
  aircraft: Array<{ id: number; alive: boolean; player: boolean; name: string; pos: number[] }>
  hud: string[] | null
  seat: string | null
  others?: Array<{ id: string; pos: number[] }>
  draws: number
  bg: number
  cam: { pos: number[]; quat: number[] } | null
  keys: { n: number; last: string }
  cockpit: number[] | null
  field: { current: string | null; names: string[] }
  apron: { spawn: number[]; dir: number[]; elev: number; stp: string } | null
  kioskBtn: number[] | null
  kioskItems: Array<{ name: string; pos: number[] }>
  preview?: { air: string; pos: number[]; radius: number } | null
  panel?: { buttons: Array<{ name: string; pos: number[] }>; log: string[] } | null
  /** GL state queries during engine draws: answered by the shadow / passed to the context. */
  glq?: { answered: number; passed: number }
  /** The session panel's gauges (src/net/gauges.ts). */
  gauge?: { now: { fps: number; simMs: number; drawMs: number; drawsPerFrame: number; heapMB: number; usedMB: number | null } | null; flight: { seconds: number; fpsAvg: number; fpsMin: number; simMs: number; drawMs: number; heapStartMB: number; heapEndMB: number; usedStartMB: number | null; usedEndMB: number | null; live: boolean } | null; lines: [string, string, string] }
  gfx: { vp: number[]; eye: number; rt: null | { w: number; h: number; samples: number }; fb: boolean; buf: number[] }
  ctl: number[] | null
  lobby: number[] | null
  kiosk: { hovers: number; lastPointer: string; ev: Record<string, number> }
  ground: { cam: number; feet: number[] | null; field: number | null; deck?: boolean; patch?: { cx: number; cz: number; n: number; spacing: number; min: number; max: number; deckSamples: number; builds: number } | null }
  /** The kiosk's loadout editor (engine side) and what the player's aircraft really carries. */
  loadout?: {
    editor: { valid: boolean; rev: number; fuel: number; smoke: boolean; smokeGenerators: number; smokeColor: number; slots: Array<{ type: number; num: number; max: number; step: number }> }
    carried: { valid: boolean; counts: number[]; fuelFraction: number; smokeOilKg: number; smokeColor: number }
  } | null
  /** SaccFlight-style hand controls (src/vr/saccControls.ts). */
  vr: { active: boolean; right: { grabbed: boolean; sel: number; visible: boolean; pos: number[] }; left: { grabbed: boolean; sel: number; visible: boolean; pos: number[] }; keys: number; lastKey: string; ail: number; elv: number; rud: number; thr: number; ab: boolean }
  /** Seat eye calibration (src/net/seatEye.ts): hip-to-eye measured, residual after applying. */
  eye: { dx: number; dy: number; dz: number; n: number; res: number[] } | null
  /** Seated body lag: residual vs the delayed visual (frames), the body lag the visuals are delayed by (ms), frame time (ms). */
  lag: { speed: number; eFrames: number; lagMs: number; dtMs: number; jitterCm: number; shakeCm: number; visOn: boolean; visBehindM: number; anchored: boolean; trailM: number; trailShakeCm: number } | null
  /** Fork commit the engine binary was built from (engine/build.sh). */
  engine?: string | null
  /** Which source held the stick at the last control flush (engine/controlBus.ts). */
  ctlOwner?: string | null
  /** Engine loading stage (engine/loadStore.ts): download | boot | field | ready. */
  load?: { stage: string; progress: number | null }
  connect?: { tries: number; max: number; failed: boolean } | null
  /** The engine's main-window view mode (FSCOCKPITVIEW = 0). */
  view?: number
  console: Array<{ id: string; pos: number[] }> | null
  mouse: { enabled: boolean; grabbed: boolean; ail: number; elv: number; grabs: number; fire: boolean }
  fire: { held: boolean; presses: number }
  voice: number
  pad: { connected: boolean; id: string; standard: boolean; active: boolean; ail: number; elv: number; rud: number; throttling: boolean; keys: number; lastKey: string }
  gates: { coarse: boolean; xr: boolean }
}

/** Start recording beacons; returns nothing, read with lastBeacon(). */
export async function watchBeacon(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ysfxTestBeacon?: unknown }
    window.addEventListener('ysfx-state', (e) => {
      w.__ysfxTestBeacon = (e as CustomEvent).detail
    })
  })
}

export async function lastBeacon(page: Page): Promise<Beacon | null> {
  return page.evaluate(() => (window as unknown as { __ysfxTestBeacon?: Beacon }).__ysfxTestBeacon ?? null)
}

/** Wait until a beacon satisfies `pred` (polls every 500 ms). */
export async function waitForBeacon(page: Page, pred: (b: Beacon) => boolean, timeoutMs = 60_000, label = 'beacon'): Promise<Beacon> {
  const t0 = Date.now()
  let last: Beacon | null = null
  while (Date.now() - t0 < timeoutMs) {
    last = await lastBeacon(page)
    if (last && pred(last)) return last
    await page.waitForTimeout(500)
  }
  throw new Error(`timeout waiting for ${label}; last beacon: ${JSON.stringify(last)}`)
}

export const NET_FLYING = 1

/** Hold a key the way a keyboard does: a press, then auto-repeat presses every 33 ms (Playwright's keyboard.down alone sends one). */
export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  const t0 = Date.now()
  do { await page.keyboard.down(key); await page.waitForTimeout(33) } while (Date.now() - t0 < ms)
  await page.keyboard.up(key)
}

// ---------------------------------------------------------------------------
// Aiming on the real host (pc / sp).  The host's crosshair interacts within
// 3.5 m (its `tc` constant), so walk in first.  Angles from the beacon's XR /
// first-person camera pose; forward = camera -Z.

function camForward(q: number[]): [number, number, number] {
  const [x, y, z, w] = q
  return [-(2 * (x * z + y * w)), -(2 * (y * z - x * w)), -(1 - 2 * (x * x + y * y))]
}

export interface AimError { id: string; dyaw: number; dpitch: number; dist: number }

/** Yaw/pitch (deg) from the camera forward to the target point, and its distance. */
export async function aimError(page: Page, target: { id: string; p: number[] }): Promise<AimError> {
  const b = await lastBeacon(page)
  if (!b?.cam) throw new Error('beacon has no camera yet')
  const cam = b.cam.pos
  const fwd = camForward(b.cam.quat)
  const seats = [target]
  const t = seats[0].p
  const d = [t[0] - cam[0], t[1] - cam[1], t[2] - cam[2]]
  const L = Math.hypot(d[0], d[1], d[2])
  d[0] /= L; d[1] /= L; d[2] /= L
  let dy = Math.atan2(d[0], d[2]) - Math.atan2(fwd[0], fwd[2])
  dy = Math.atan2(Math.sin(dy), Math.cos(dy))
  const dp = Math.asin(d[1]) - Math.asin(fwd[1])
  return { id: seats[0].id, dyaw: (dy * 180) / Math.PI, dpitch: (dp * 180) / Math.PI, dist: L }
}

export const INTERACT_RANGE = 3.5

/**
 * Walk toward the nearest pedestal until within `within` metres, then centre
 * the crosshair on it.  `look(dyawDeg, dpitchDeg)` turns the view by the
 * given angles; `walk(ms)` moves forward for a while.
 */
export async function walkAndAim(
  page: Page,
  look: (dyawDeg: number, dpitchDeg: number) => Promise<void>,
  walk: (ms: number) => Promise<void>,
  within: number,
  target: { id: string; p: number[] },
): Promise<AimError> {
  let e = await aimError(page, target)
  for (let it = 0; it < 40 && e.dist >= within; it++) {
    if (Math.abs(e.dyaw) > 2) await look(e.dyaw * 0.8, 0)
    else {
      await walk(Math.min(400, Math.max(80, (e.dist - within + 0.3) * 120)))
      await page.waitForTimeout(450)
    }
    e = await aimError(page, target)
  }
  for (let it = 0; it < 12; it++) {
    e = await aimError(page, target)
    if (Math.abs(e.dyaw) < 1 && Math.abs(e.dpitch) < 1) break
    await look(e.dyaw * 0.8, e.dpitch * 0.8)
  }
  return e
}

/**
 * Keep the saved production session alive: after a run, write the context's
 * cookies back to the auth file when its refresh token outlives the saved
 * one (the server may renew it on use).  Never overwrites with a session that
 * lost its refresh token (logged out, kicked): the file then stays as it was.
 */
export async function keepAuth(context: import('@playwright/test').BrowserContext, authFile: string): Promise<void> {
  const fs = await import('node:fs')
  type Cookie = { name: string; expires: number; value?: string }
  const find = (cookies: Cookie[], name: string) => cookies.find((c) => c.name === name)
  const state = await context.storageState()
  const freshR = find(state.cookies, 'xrift-refresh-token')
  if (!freshR) { console.log('[auth] this run ended without a refresh token: saved session left as it was'); return }
  let savedCookies: Cookie[] = []
  try { savedCookies = JSON.parse(fs.readFileSync(authFile, 'utf8')).cookies ?? [] } catch { /* unreadable: leave it alone */ return }
  const savedR = find(savedCookies, 'xrift-refresh-token')
  const fresh = freshR.expires
  const saved = savedR?.expires ?? -1
  // Write back when the session moved on in any way: a longer refresh token,
  // a different one (the server may hand out a new one on use, and the old
  // one then stops working -- suspected after every run lost its login at
  // once, 2026-11-10), or a newer access token.
  const accessNewer = (find(state.cookies, 'xrift-access-token')?.expires ?? -1) > (find(savedCookies, 'xrift-access-token')?.expires ?? -1) + 60
  if (fresh > saved + 60 || (fresh >= saved - 60 && (freshR.value !== savedR?.value || accessNewer))) {
    fs.writeFileSync(authFile, JSON.stringify(state, null, 2))
    console.log(`[auth] session renewed: refresh token now good for ${((fresh - Date.now() / 1000) / 86400).toFixed(1)} days`)
  } else console.log(`[auth] saved session kept: refresh token good for ${((saved - Date.now() / 1000) / 86400).toFixed(1)} days`)
}

/**
 * A standard-mapping gamepad the test drives: navigator.getGamepads() returns
 * one pad whose axes and buttons are whatever setPad() last wrote.  Call
 * before page.goto (init script).
 */
export async function installFakePad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const st = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => 0), on: false }
    ;(window as unknown as { __fakePad: typeof st }).__fakePad = st
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => st.on ? [{
        id: 'Fake Standard Pad', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
        axes: st.axes.slice(), buttons: st.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0, value: v })),
      }] : [],
    })
  })
}

export async function setPad(page: Page, patch: { axes?: number[]; buttons?: Record<number, number>; on?: boolean }): Promise<void> {
  await page.evaluate((p) => {
    const st = (window as unknown as { __fakePad: { axes: number[]; buttons: number[]; on: boolean } }).__fakePad
    if (p.on !== undefined) st.on = p.on
    if (p.axes) st.axes = p.axes
    if (p.buttons) for (const [i, v] of Object.entries(p.buttons)) st.buttons[Number(i)] = v
  }, patch)
}
