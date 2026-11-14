/**
 * local-gauge: the session panel's gauges (src/net/gauges.ts) read real
 * numbers -- frame rate, the engine's cost per frame, the wasm heap from the
 * engine's own heap gauge -- and keep a row for the flight after it ends.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345681'

test('gauges: now row, flight row while seated, flight row kept after leaving', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')

  const g0 = await waitForBeacon(page, (b) => !!b.gauge?.now && b.gauge.now.usedMB !== null, 20_000, 'gauge reading with the engine heap gauge')
  const n = g0.gauge!.now!
  console.log(`[gauge] ${g0.gauge!.lines[0]}`)
  expect(n.fps).toBeGreaterThan(5)
  expect(n.drawsPerFrame).toBeGreaterThan(0.5)
  expect(n.simMs).toBeGreaterThan(0)
  expect(n.drawMs).toBeGreaterThan(0)
  // The engine's figure is the wasm memory itself; malloc'd bytes fit inside it.
  expect(n.heapMB).toBeGreaterThan(16)
  expect(n.usedMB!).toBeGreaterThan(1)
  expect(n.usedMB!).toBeLessThan(n.heapMB)
  expect(g0.gauge!.flight).toBeNull()
  await page.screenshot({ path: test.info().outputPath('local-gauge-panel.png') })

  // Fly: the flight row fills while seated.
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  const fly = await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING && !!b.seat, 30_000, 'flying and seated')
  const live = await waitForBeacon(page, (b) => !!b.gauge?.flight && b.gauge.flight.live && b.gauge.flight.seconds >= 3, 20_000, 'flight row live')
  console.log(`[gauge] seat ${fly.seat}: ${live.gauge!.lines[1]}`)
  expect(live.gauge!.lines[1]).toMatch(/^飛行中/)
  expect(live.gauge!.flight!.fpsMin).toBeLessThanOrEqual(live.gauge!.flight!.fpsAvg + 1e-6)
  expect(live.gauge!.flight!.heapEndMB).toBeGreaterThanOrEqual(live.gauge!.flight!.heapStartMB)
  await page.screenshot({ path: test.info().outputPath('local-gauge-flying.png') })

  // Leave: the row stays, relabelled, and stops counting.
  await page.keyboard.down('Space'); await page.waitForTimeout(300); await page.keyboard.up('Space')
  const kept = await waitForBeacon(page, (b) => !b.seat && !!b.gauge?.flight && !b.gauge.flight.live, 20_000, 'flight row kept after leaving')
  console.log(`[gauge] ${kept.gauge!.lines[1]} / ${kept.gauge!.lines[2].trim()}`)
  expect(kept.gauge!.lines[2]).toMatch(/メモリ \d+MB \(use \d+\) -> \d+MB \(use \d+\)/)
  expect(kept.gauge!.lines[1]).toMatch(/^前回の飛行/)
  const secs = kept.gauge!.flight!.seconds
  await page.waitForTimeout(2500)
  const later = await waitForBeacon(page, (b) => !!b.gauge?.flight, 5_000, 'still there')
  expect(later.gauge!.flight!.seconds).toBe(secs)
  await page.screenshot({ path: test.info().outputPath('local-gauge.png') })
})
