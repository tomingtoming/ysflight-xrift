/**
 * prod-pc: the real XRift host, desktop Chrome.  Needs tests/.auth/xrift.json
 * (npm run test:auth).  Drives the real desktop controls: pointer lock by a
 * click, mouse look (synthesised mouse moves carry movementX/Y under pointer
 * lock, but never jump the virtual pointer back -- that undoes the look),
 * WASD walk, click on the crosshair target to sit, W/S/A/D stick, Q throttle,
 * Space to leave.
 */
import { expect, test } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { enterWorld, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

const DEG_PER_PX = 0.115 // host mouse sensitivity, measured 2026-11-09

test('desktop: walk, sit by crosshair, stick, throttle, leave', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  expect(['host', 'client']).toContain(b.role)
  await waitForBeacon(page, (x) => !!x.cam && x.seats.length > 0, 20_000, 'camera + seats')

  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)

  let mx = 640, my = 360
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    mx += dx; my += dy
    await page.mouse.move(mx, my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  const aim = await walkAndAim(page, look, walk)
  test.info().annotations.push({ type: 'aim', description: `${aim.id} dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}` })
  await page.screenshot({ path: test.info().outputPath('pc-aimed.png') })

  await page.mouse.click(mx, my)
  const seated = await waitForBeacon(page, (x) => x.seat !== null, 8_000, 'seated after click')
  expect(seated.seat).toBe(aim.id)
  const flying = await waitForBeacon(page, (x) => !!x.net && x.net.state === NET_FLYING, 40_000, 'flying')
  expect(flying.aircraft.some((a) => a.player)).toBe(true)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD')

  await page.keyboard.down('w')
  const stick = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[2] < -0.5, 10_000, 'stick forward')
  expect(stick.ctl![2]).toBeLessThan(-0.5)
  await page.keyboard.up('w')
  await waitForBeacon(page, (x) => !!x.ctl && Math.abs(x.ctl[2]) < 0.05, 10_000, 'stick released')

  for (let i = 0; i < 25; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  const thr = await waitForBeacon(page, (x) => !!x.flight && x.flight[7] > 0.9 && x.flight[1] > 5, 15_000, 'throttle up, rolling')
  expect(thr.flight![7]).toBeGreaterThan(0.9)
  await page.screenshot({ path: test.info().outputPath('pc-flying.png') })

  // Space leaves the seat -- held, not tapped: a synthesised press of
  // ~50-120 ms is not seen by the host's seat loop (measured 2026-11-09),
  // 600 ms is.  Only the seat is asserted here; the engine's own leave
  // (flying -> standby) follows a little later.
  let left = null as Awaited<ReturnType<typeof waitForBeacon>> | null
  for (let attempt = 0; attempt < 2 && !left; attempt++) {
    await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
    left = await waitForBeacon(page, (x) => x.seat === null, 6_000, 'left the seat').catch(() => null)
  }
  if (!left) throw new Error(`still seated after Space; last beacon: ${JSON.stringify(await lastBeacon(page))}`)
  await waitForBeacon(page, (x) => !!x.net && x.net.state !== NET_FLYING, 20_000, 'engine left the flight')
})
