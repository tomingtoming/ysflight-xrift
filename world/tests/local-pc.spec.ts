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
  // The aircraft rolls along the runway: its velocity direction is the apron's runway direction (World.tsx heading convention).
  const p0 = settled.aircraft.find((a) => a.player)!.pos
  await page.waitForTimeout(1000)
  const b2 = (await lastBeacon(page))!
  const p1 = b2.aircraft.find((a) => a.player)!.pos
  const v = [p1[0] - p0[0], p1[2] - p0[2]]
  const vl = Math.hypot(v[0], v[1])
  const dot = (v[0] * b2.apron!.dir[0] + v[1] * b2.apron!.dir[1]) / vl
  console.log(`[kiosk heading] velocity dir ${(v[0] / vl).toFixed(2)},${(v[1] / vl).toFixed(2)} apron dir ${b2.apron!.dir.map((n) => n.toFixed(2)).join(',')} cos ${dot.toFixed(3)}`)
  expect(dot).toBeGreaterThan(0.98)

  // Space (held) is the host's leave key in the dev environment too.  The
  // aircraft stays, parked: throttle idle, brake on, still the player's.
  const airBefore = settled.net!.playerAirId
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  const left = await waitForBeacon(page, (b) => b.seat === null && !!b.net && b.net.state === NET_FLYING && b.aircraft.some((a) => a.player && a.alive), 20_000, 'left the seat, aircraft parked')
  const parked = await waitForBeacon(page, (b) => !!b.flight && b.flight[7] < 0.05 && b.flight[10] > 0.5, 10_000, 'parked: throttle idle, brake on')
  console.log(`[kiosk parked] throttle ${parked.flight![7].toFixed(2)} brake ${parked.flight![10]} cockpit ${JSON.stringify(parked.cockpit?.map((n) => Math.round(n)))}`)
  expect(left.seat).toBeNull()
  // 飛行開始 again replaces the parked aircraft with a new one.
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_03'))
  const again = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.net.playerAirId !== airBefore && b.net.playerAirId >= 0, 40_000, 'new aircraft boarded')
  console.log(`[kiosk again] aircraft ${airBefore} -> ${again.net!.playerAirId}, alive ${again.aircraft.filter((a) => a.alive).length}`)
  expect(again.aircraft.filter((a) => a.alive).length).toBe(1)
})

test('host changes the field: every list reloads, the apron moves, a flight starts there', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready, 90_000, 'server ready')
  const b0 = await waitForBeacon(page, (b) => !!b.lobby && b.lobby[0] > 10 && b.field.names.length > 1 && !!b.apron, 30_000, 'lists, field names, apron')
  console.log(`[field] current ${b0.field.current}, ${b0.field.names.length} fields: ${b0.field.names.slice(0, 8).join(' ')}…; apron ${JSON.stringify(b0.apron)}`)
  console.log(`[field] kiosk button ${JSON.stringify(b0.kioskBtn?.map((n) => +n.toFixed(2)))}; field items ${JSON.stringify(b0.kioskItems.map((i) => [i.name, ...i.pos.map((n) => +n.toFixed(2))]))}`)
  expect(b0.field.current).toBe('ATSUGI_AIRBASE')
  // Atsugi's apron is where the first worlds put it by hand (spawn ahead of RW01_01, runway toward -z).
  expect(Math.hypot(b0.apron!.spawn[0] + 117, b0.apron!.spawn[2] - 640)).toBeLessThan(6)
  expect(Math.abs(b0.apron!.elev)).toBeLessThan(0.5)
  const kiosk0 = b0.kioskBtn!

  // A flat field other than Atsugi (identifiers from the engine's own list).
  const pick = b0.field.names.find((n) => /HEATHROW|NAHA|KYUSYU|AOMORI/.test(n)) ?? b0.field.names.find((n) => n !== b0.field.current)!
  const r = await page.evaluate((f) => (window as unknown as { __ysfxSetField: (f: string) => string }).__ysfxSetField(f), pick)
  expect(r).toBe('set')
  const b1 = await waitForBeacon(page, (b) => b.field.current === pick && !!b.net && b.net.ready && !!b.lobby && b.lobby[0] > 10 && !!b.apron && b.apron.stp !== 'RW01_01' || (b.field.current === pick && !!b.apron && Math.hypot(b.apron.spawn[0] - b0.apron!.spawn[0], b.apron.spawn[2] - b0.apron!.spawn[2]) > 150), 120_000, 'engine restarted on the new field')
  console.log(`[field] -> ${b1.field.current}: start positions ${b1.lobby?.[1]}, apron ${JSON.stringify(b1.apron)}`)
  expect(Math.hypot(b1.apron!.spawn[0] - b0.apron!.spawn[0], b1.apron!.spawn[2] - b0.apron!.spawn[2])).toBeGreaterThan(150)
  const moved = await waitForBeacon(page, (b) => !!b.kioskBtn && Math.hypot(b.kioskBtn[0] - kiosk0[0], b.kioskBtn[2] - kiosk0[2]) > 150, 10_000, 'kiosk moved to the new apron')
  console.log(`[field] kiosk ${JSON.stringify(moved.kioskBtn?.map((n) => Math.round(n)))}`)
  // (The dev environment's teleport is a console.log stub, so the visitor's move
  // to the new apron is asserted on the production host, prod-pc.spec.ts.)
  // And a flight starts from the new field's first start position.
  await page.evaluate((stp) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', stp), b1.apron!.stp)
  const flying = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING, 40_000, 'flying on the new field')
  expect(flying.aircraft.some((a) => a.player && a.alive)).toBe(true)
  await page.screenshot({ path: test.info().outputPath('local-field.png') })
})

