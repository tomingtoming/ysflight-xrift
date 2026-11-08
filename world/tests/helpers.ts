import type { Page } from '@playwright/test'

/** The world's read-only beacon (src/net/StateBeacon.tsx). */
export interface Beacon {
  t: number
  role: 'host' | 'client' | null
  room: string | null
  net: { mode: number; ready: boolean; state: number; waiting: boolean; playerAirId: number; connected: number; runState: number; fatal: number } | null
  flight: number[] | null
  aircraft: Array<{ id: number; alive: boolean; player: boolean; name: string; pos: number[] }>
  hud: string[] | null
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
