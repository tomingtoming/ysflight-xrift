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
  if (!/\/instance\//.test(page.url())) {
    const card = page.locator('h4').filter({ hasText: '#' }).first()
    const create = page.getByRole('button', { name: /^(➕ )?(新規)?作成$/ }) // "新規作成" with a list, "作成" on the empty-state form
    await Promise.any([card.waitFor({ timeout: 30_000 }), create.waitFor({ timeout: 30_000 })])
    if (!(await card.count())) {
      await create.click() // creates it and lists it; the card is still the way in
      await card.waitFor({ timeout: 30_000 })
    }
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
  const enter = page.getByRole('button', { name: /入室する/ })
  await enter.waitFor({ timeout: 60_000 })
  await enter.click()
  return page.url()
}

/** The world's read-only beacon (src/net/StateBeacon.tsx). */
export interface Beacon {
  t: number
  role: 'host' | 'client' | null
  room: string | null
  net: { mode: number; ready: boolean; state: number; waiting: boolean; playerAirId: number; connected: number; runState: number; fatal: number } | null
  flight: number[] | null
  aircraft: Array<{ id: number; alive: boolean; player: boolean; name: string; pos: number[] }>
  hud: string[] | null
  seat: string | null
  draws: number
  cam: { pos: number[]; quat: number[] } | null
  seats: Array<{ id: string; pos: number[] }>
  gfx: { vp: number[]; eye: number; rt: null | { w: number; h: number; samples: number }; fb: boolean; buf: number[] }
  ctl: number[] | null
  lobby: number[] | null
  ground: { cam: number; feet: number[] | null; field: number | null }
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

// ---------------------------------------------------------------------------
// Aiming on the real host (pc / sp).  The host's crosshair interacts within
// 3.5 m (its `tc` constant), so walk in first.  Angles from the beacon's XR /
// first-person camera pose; forward = camera -Z.

function camForward(q: number[]): [number, number, number] {
  const [x, y, z, w] = q
  return [-(2 * (x * z + y * w)), -(2 * (y * z - x * w)), -(1 - 2 * (x * x + y * y))]
}

export interface AimError { id: string; dyaw: number; dpitch: number; dist: number }

/** Yaw/pitch (deg) from the camera forward to the nearest pedestal's hit-box centre, and its distance. */
export async function aimError(page: Page, target?: { id: string; p: number[] }): Promise<AimError> {
  const b = await lastBeacon(page)
  if (!b?.cam || (!target && b.seats.length === 0)) throw new Error('beacon has no camera/seats yet')
  const cam = b.cam.pos
  const fwd = camForward(b.cam.quat)
  const seats = target
    ? [target]
    : b.seats
        .map((s) => ({ id: s.id, p: [s.pos[0], s.pos[1] + 0.5, s.pos[2]] }))
        .sort((a, c) => Math.hypot(a.p[0] - cam[0], a.p[2] - cam[2]) - Math.hypot(c.p[0] - cam[0], c.p[2] - cam[2]))
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
  within = 2.6,
  target?: { id: string; p: number[] },
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
