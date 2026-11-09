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
    const create = page.getByRole('button', { name: /新規作成/ })
    await Promise.race([card.waitFor({ timeout: 30_000 }), create.waitFor({ timeout: 30_000 })])
    if (await card.count()) await card.click()
    else await create.click()
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
