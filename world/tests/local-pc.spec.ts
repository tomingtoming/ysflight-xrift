/**
 * local-pc: the whole kiosk -> cockpit flow in the dev environment, PC input.
 * Forces the host role (?ysfxnet=host:ROOM) so no election is needed.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, lastBeacon, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345678'

test('kiosk start -> join -> keyboard stick, mouse stick, throttle and HUD', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)

  // Engine boots in -server mode and the lobby becomes ready.
  const ready = await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  expect(ready.room).toBe(ROOM)

  // Standing on the field: the engine draws the airfield while nobody is
  // aboard (lobby standby, external-view host).  Draw calls keep coming
  // and the frame is captured for a visual check.
  const standby = await waitForBeacon(page, (b) => b.draws > 60, 20_000, 'engine drawing in standby')
  expect(standby.net!.state).toBe(0)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: test.info().outputPath('local-standby.png') })
  const g = await lastBeacon(page)
  console.log(`[ground:dev] ${JSON.stringify(g?.ground)}`)

  // Start from the kiosk via the dev hook (Pointer Lock cannot be granted to
  // automation): the cockpit seat boards the player when the aircraft appears.
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  const flying = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'seated and flying')
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

  // Mouse stick: hold the left button, the mouse's travel since the grab is
  // the deflection (250 px = full); release and it springs back.
  await page.mouse.move(640, 360)
  await page.mouse.down()
  await page.mouse.move(640 + 150, 360, { steps: 10 })
  const ms = await waitForBeacon(page, (b) => b.mouse.grabbed && !!b.ctl && b.ctl[0] === 1 && b.ctl[1] > 0.5, 5_000, 'mouse stick: roll right')
  console.log(`[mouse stick] right 150 px -> ail ${ms.ctl![1].toFixed(2)} elv ${ms.ctl![2].toFixed(2)}`)
  await page.mouse.move(640 + 150, 360 - 150, { steps: 10 })
  const mf = await waitForBeacon(page, (b) => !!b.ctl && b.ctl[2] < -0.5, 5_000, 'mouse stick: pushed forward = nose down')
  console.log(`[mouse stick] forward 150 px -> ail ${mf.ctl![1].toFixed(2)} elv ${mf.ctl![2].toFixed(2)}`)
  await page.screenshot({ path: test.info().outputPath('local-mouse-stick.png') })
  await page.mouse.up()
  await waitForBeacon(page, (b) => !b.mouse.grabbed && !!b.ctl && Math.abs(b.ctl[1]) < 0.05 && Math.abs(b.ctl[2]) < 0.05, 5_000, 'mouse stick released')

  // Throttle via the keyboard path (Q) raises speed.
  for (let i = 0; i < 20; i++) await page.keyboard.press('q')
  const moving = await waitForBeacon(page, (b) => !!b.flight && b.flight[1] * 3.6 > 5, 20_000, 'speed > 5 km/h')
  expect(moving.flight![7]).toBeGreaterThan(0.2)
  // A is YSFLIGHT's throttle-down key; the host also folds it into the seat's
  // roll axis, which the seat takes back out: throttle drops, no roll.
  await page.waitForTimeout(600) // let the Q presses finish landing
  const before = (await lastBeacon(page))!.flight![7]
  await page.keyboard.down('a')
  await page.waitForTimeout(700)
  const aHeld = (await lastBeacon(page))!
  await page.keyboard.up('a')
  console.log(`[A held] throttle ${before.toFixed(2)} -> ${aHeld.flight![7].toFixed(2)}, aileron ${aHeld.ctl![1].toFixed(2)}`)
  expect(aHeld.flight![7]).toBeLessThan(before - 0.03)
  expect(Math.abs(aHeld.ctl![1])).toBeLessThan(0.05)
  await page.screenshot({ path: test.info().outputPath('local-pc.png') })
})

test('kiosk start boards the cockpit seat, standing up leaves', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready, 90_000, 'server ready')
  // The kiosk read the engine's lists: many aircraft, several start positions.
  const lobby = await waitForBeacon(page, (b) => !!b.lobby && b.lobby[0] > 10 && b.lobby[1] > 1, 20_000, 'lobby lists')
  console.log(`[lobby:dev] aircraft ${lobby.lobby![0]}, start positions ${lobby.lobby![1]}`)

  const r = await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_02'))
  expect(r).toBe('requested')
  const seated = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit', 30_000, 'auto-seated in the cockpit')
  expect(seated.net!.state).toBe(NET_FLYING)
  await waitForBeacon(page, (b) => !!b.hud && /SPD/.test(b.hud[0]), 15_000, 'hud')
  await page.screenshot({ path: test.info().outputPath('local-kiosk-flying.png') })

  // Full throttle down the runway: the seated camera must stay on the
  // cockpit at speed.  lag.eFrames is the camera's residual lag along the
  // velocity in frames (seatLead.ts), measured after the lead is applied.
  for (let i = 0; i < 20; i++) await page.keyboard.press('q')
  const fast = await waitForBeacon(page, (b) => !!b.lag && b.lag.speed > 40, 40_000, 'speed > 40 m/s')
  console.log(`[kiosk lag:first] speed ${fast.lag!.speed.toFixed(1)} m/s, camera lag ${fast.lag!.eFrames.toFixed(2)} frames, lead ${fast.lag!.leadMs.toFixed(1)} ms`)
  await page.waitForTimeout(1500)
  const settled = await waitForBeacon(page, (b) => !!b.lag && b.lag.speed > 40 && Math.abs(b.lag.eFrames) < 0.3, 10_000, 'camera on the cockpit at speed')
  console.log(`[kiosk lag:settled] speed ${settled.lag!.speed.toFixed(1)} m/s, camera lag ${settled.lag!.eFrames.toFixed(2)} frames, lead ${settled.lag!.leadMs.toFixed(1)} ms`)
  await page.screenshot({ path: test.info().outputPath('local-kiosk-fast.png') })

  // Space (held) is the host's leave key in the dev environment too.
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  const left = await waitForBeacon(page, (b) => b.seat === null && !!b.net && b.net.state !== NET_FLYING, 20_000, 'left the flight')
  expect(left.seat).toBeNull()
})
