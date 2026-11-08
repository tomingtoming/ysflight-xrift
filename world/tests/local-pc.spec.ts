/**
 * local-pc: the whole seat flow in the dev environment, PC input.
 * Forces the host role (?ysfxnet=host:ROOM) so no election is needed.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345678'

test('sit on a pedestal -> join -> stick and HUD', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)

  // Engine boots in -server mode and the lobby becomes ready.
  const ready = await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  expect(ready.room).toBe(ROOM)

  // Sit via the dev hook (Pointer Lock cannot be granted to automation).
  await page.evaluate(() => (window as unknown as { __ysfxSit: (id: string) => void }).__ysfxSit('ysfx-board-RW01_01'))
  const flying = await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'flying')
  expect(flying.aircraft.some((a) => a.player && a.alive)).toBe(true)

  // HUD lines appear.
  const hud = await waitForBeacon(page, (b) => !!b.hud && /SPD/.test(b.hud[0]), 15_000, 'hud')
  expect(hud.hud![0]).toMatch(/ALT/)

  // The host's seated 2-axis input reaches the engine stick: W pushes the nose down (elevator < 0).
  await page.keyboard.down('w')
  await page.waitForTimeout(1200)
  const elv = await page.evaluate(() => {
    const m = (window as unknown as { __ysfx: { HEAPF32: Float32Array; _FsVrControlDataPointer: () => number } }).__ysfx
    const c = m._FsVrControlDataPointer() >> 2
    return [m.HEAPF32[c], m.HEAPF32[c + 1], m.HEAPF32[c + 2]]
  })
  await page.keyboard.up('w')
  expect(elv[0]).toBe(1)
  expect(elv[2]).toBeLessThan(-0.5)

  // Throttle via the keyboard path (Q) raises speed.
  for (let i = 0; i < 20; i++) await page.keyboard.press('q')
  const moving = await waitForBeacon(page, (b) => !!b.flight && b.flight[1] * 3.6 > 5, 20_000, 'speed > 5 km/h')
  expect(moving.flight![7]).toBeGreaterThan(0.2)
})
