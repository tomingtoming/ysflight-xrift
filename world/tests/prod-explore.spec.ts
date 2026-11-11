/**
 * prod-explore: one-off probes of the real host (not part of the suite's
 * assertions).  Here: how does a seated desktop player get a third-person
 * view?  The wheel is tried in both directions, the camera's distance from
 * the cockpit point is printed.
 */
import { test, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { enterWorld, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

const WORLD_URL = process.env.YSFX_WORLD_URL ?? 'https://app.xrift.net/world/a172ce51-3601-45ec-8a64-6af6a8b53cfb'
test.skip(!existsSync(resolve(import.meta.dirname, '.auth/xrift.json')), 'no saved login')
const DEG_PER_PX = 0.115

async function dist(page: Page): Promise<string> {
  const b = (await lastBeacon(page))!
  if (!b.cam || !b.cockpit) return 'n/a'
  const d = Math.hypot(b.cam.pos[0] - b.cockpit[0], b.cam.pos[1] - b.cockpit[1], b.cam.pos[2] - b.cockpit[2])
  return `${d.toFixed(2)} m (cam y ${b.cam.pos[1].toFixed(2)}, seat y ${b.cockpit[1].toFixed(2)})`
}

test('explore: third-person view of a seated desktop player', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready && !!x.apron && !!x.kioskBtn, 150_000, 'ready')
  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  const cur = { mx: 640, my: 360 }
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    cur.mx += dx; cur.my += dy
    await page.mouse.move(cur.mx, cur.my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  const placed = await waitForBeacon(page, (x) => !!x.kioskBtn, 30_000, 'button')
  await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: placed.kioskBtn! })
  console.log(`[explore] standing: cam-to-nothing; wheel test before sitting`)
  await page.mouse.click(cur.mx, cur.my)
  await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit' && !!x.net && x.net.state === NET_FLYING, 40_000, 'seated')
  await page.waitForTimeout(2500)
  console.log(`[explore] seated: ${await dist(page)}`)
  for (const [label, act] of [
    ['wheel down 600', () => page.mouse.wheel(0, 600)],
    ['wheel down 600 again', () => page.mouse.wheel(0, 600)],
    ['wheel up 2400', () => page.mouse.wheel(0, -2400)],
    ['wheel down 3000', () => page.mouse.wheel(0, 3000)],
  ] as Array<[string, () => Promise<void>]>) {
    await act()
    await page.waitForTimeout(1200)
    console.log(`[explore] ${label}: ${await dist(page)}`)
  }
  await page.screenshot({ path: test.info().outputPath('explore-wheel.png') })
  // the host's menu, for whatever view switch it offers
  const texts = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()).filter(Boolean).slice(0, 40))
  console.log(`[explore] buttons: ${JSON.stringify(texts)}`)
})
