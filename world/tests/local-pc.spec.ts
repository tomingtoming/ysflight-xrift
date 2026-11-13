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

  // YSFLIGHT's own rudder keys keep working while the seat input holds the
  // stick: the block flags no yaw axis (fsvr.h [11]), so Z/C reach the engine
  // and flight[15] is the rudder it flies with.  (A desktop pilot had no yaw
  // at all before, 2026-11-10.)
  await page.keyboard.down('z')
  await page.waitForTimeout(1000)
  const rz = (await lastBeacon(page))!.flight![15]
  await page.keyboard.up('z')
  await page.keyboard.down('c')
  await page.waitForTimeout(2000)
  const rc = (await lastBeacon(page))!.flight![15]
  await page.keyboard.up('c')
  console.log(`[rudder] Z held 1 s -> ${rz.toFixed(2)}, then C held 2 s -> ${rc.toFixed(2)}`)
  expect(Math.abs(rz)).toBeGreaterThan(0.2)
  expect(rc).toBeLessThan(rz - 0.2)

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

  // Fire: Shift and the right mouse button hold the engine's fire key (Space
  // itself is the host's "stand up").  The gun's round count on the HUD drops.
  const gun = (b: { hud: string[] | null }) => Number(/GUN\s+(\d+)/.exec((b.hud ?? []).join(' '))?.[1] ?? NaN)
  const g0 = gun((await lastBeacon(page))!)
  await page.keyboard.down('Shift')
  await waitForBeacon(page, (b) => b.fire.held, 5_000, 'Shift holds the fire key')
  await page.waitForTimeout(700)
  await page.keyboard.up('Shift')
  const s1 = await waitForBeacon(page, (b) => !b.fire.held, 5_000, 'Shift released')
  const g1 = gun(s1)
  await page.mouse.down({ button: 'right' })
  await waitForBeacon(page, (b) => b.fire.held && b.mouse.fire, 5_000, 'right button holds the fire key')
  await page.waitForTimeout(700)
  await page.mouse.up({ button: 'right' })
  const s2 = await waitForBeacon(page, (b) => !b.fire.held, 5_000, 'right button released')
  await page.waitForTimeout(600)
  const g2 = gun((await lastBeacon(page))!)
  console.log(`[fire] gun rounds ${g0} -> Shift 0.7 s -> ${g1} -> right button 0.7 s -> ${g2}; presses ${s2.fire.presses}`)
  expect(g1).toBeLessThan(g0)
  expect(g2).toBeLessThan(g1)
  expect(s2.seat).toBe('ysfx-cockpit')

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
  console.log(`[kiosk lag:first] speed ${fast.lag!.speed.toFixed(1)} m/s, residual ${fast.lag!.eFrames.toFixed(2)} frames, body lag ${fast.lag!.lagMs.toFixed(1)} ms (frame ${fast.lag!.dtMs.toFixed(1)} ms)`)
  await page.waitForTimeout(1500)
  const settled = await waitForBeacon(page, (b) => !!b.lag && b.lag.speed > 40 && Math.abs(b.lag.eFrames) < 0.3, 10_000, 'camera on the cockpit at speed')
  console.log(`[kiosk lag:settled] speed ${settled.lag!.speed.toFixed(1)} m/s, residual ${settled.lag!.eFrames.toFixed(2)} frames, body lag ${settled.lag!.lagMs.toFixed(1)} ms, travel jitter ${settled.lag!.jitterCm.toFixed(1)} cm/frame, body-vs-visual shake ${settled.lag!.shakeCm.toFixed(1)} cm`)
  // The dev stand-in lands the body one frame late, as the production desktop
  // does (seatLead.ts setDevBodyLag): the measured lag is that frame, and the
  // feet trail the true seat by lag x speed.
  expect(Math.abs(settled.lag!.lagMs - settled.lag!.dtMs)).toBeLessThan(4)
  const gap = Math.hypot(settled.ground.feet![0] - settled.cockpit![0], settled.ground.feet![2] - settled.cockpit![2])
  // (The beacon pairs this frame's seat with the stand-in's feet as of the
  // start of the frame, one frame older than the production host's body is
  // by the time its beacon runs: lag + one frame here.)
  const trail = ((settled.lag!.lagMs + settled.lag!.dtMs) / 1000) * settled.lag!.speed
  console.log(`[kiosk body] feet-to-seat ${gap.toFixed(2)} m, body lag + beacon frame ${trail.toFixed(2)} m at ${settled.lag!.speed.toFixed(0)} m/s`)
  expect(Math.abs(gap - trail)).toBeLessThan(0.6)
  // Desktop, any view: the drawn aircraft, the HUD and the camera are shifted together onto the late body
  // (CockpitSeat, 'all'), so the visuals are already off the simulated pose here.  Then force the VR path:
  // the drawn aircraft and the HUD go back by the body's lag, i.e. onto the body.
  expect(settled.lag!.visOn).toBe(true)
  expect(settled.lag!.anchored).toBe(true)
  await page.evaluate(() => (window as unknown as { __ysfxBodyLag: (n: number, f: boolean) => string }).__ysfxBodyLag(1, true))
  await page.waitForTimeout(1500)
  const delayed = await waitForBeacon(page, (b) => !!b.lag && b.lag.visOn && Math.abs(b.lag.eFrames) < 0.3, 10_000, 'visuals delayed onto the body')
  const want = (delayed.lag!.lagMs / 1000) * delayed.lag!.speed
  console.log(`[kiosk delayed] visual ${delayed.lag!.visBehindM.toFixed(2)} m behind the simulated pose, body lag ${want.toFixed(2)} m at ${delayed.lag!.speed.toFixed(0)} m/s, shake ${delayed.lag!.shakeCm.toFixed(1)} cm`)
  expect(Math.abs(delayed.lag!.visBehindM - want)).toBeLessThan(0.15)
  expect(delayed.lag!.anchored).toBe(true)
  // A display faster than physics (here 60 Hz frames, 40 Hz steps): the body
  // advances in stairs.  The visuals are anchored to it at render time, so
  // they sit on the body every frame however far it wanders.
  await page.evaluate(() => (window as unknown as { __ysfxBodyLag: (n: number, f: boolean, hz: number) => string }).__ysfxBodyLag(1, true, 40))
  await page.waitForTimeout(1500)
  let worst = 0
  for (let i = 0; i < 10; i++) {
    const s = (await lastBeacon(page))!.lag!
    expect(s.anchored).toBe(true)
    worst = Math.max(worst, Math.abs(s.visBehindM - s.trailM))
    await page.waitForTimeout(110)
  }
  const stair = (await lastBeacon(page))!.lag!
  console.log(`[kiosk stairs] body wanders ${stair.trailShakeCm.toFixed(0)} cm RMS around ${stair.trailM.toFixed(2)} m behind at ${stair.speed.toFixed(0)} m/s; visual off the body by at most ${(worst * 100).toFixed(1)} cm`)
  expect(stair.trailShakeCm).toBeGreaterThan(10)
  expect(worst).toBeLessThan(0.05)
  await page.evaluate(() => (window as unknown as { __ysfxBodyLag: (n: number, f: boolean) => string }).__ysfxBodyLag(1, false))
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
  expect(Math.hypot(b0.apron!.spawn[0] + 73.6, b0.apron!.spawn[2] - 647.5)).toBeLessThan(6) // beside the runway: 40 m right of the point 23 m ahead of RW01_01
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


test('loading panel: shown while the engine loads, gone when the field is ready', async ({ page }) => {
  // Slow the 24 MB data package down so the download stage is there to see.
  await page.route('**/ysflight32_gl2.data', async (route) => { await new Promise((r) => setTimeout(r, 2500)); await route.continue() })
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  const loading = await waitForBeacon(page, (b) => !!b.load && b.load.stage !== 'ready', 20_000, 'loading stage reported')
  await page.waitForTimeout(800)
  await page.screenshot({ path: test.info().outputPath('loading-panel.png') })
  console.log(`[loading] first stage ${loading.load!.stage}`)
  const ready = await waitForBeacon(page, (b) => !!b.load && b.load.stage === 'ready' && !!b.apron, 60_000, 'field ready')
  expect(ready.net!.ready).toBe(true)
  await page.waitForTimeout(500)
  await page.screenshot({ path: test.info().outputPath('loading-done.png') })
})

test('view keys cannot leave the cockpit view while piloting; a crash puts the pilot back on the apron', async ({ page }) => {
  test.setTimeout(180_000)
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.apron, 90_000, 'server ready')
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  const seated = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING, 30_000, 'seated and flying')
  const apron = seated.apron!
  // F1 again, the weapon view, the outside view: the HUD is only drawn in the cockpit view.
  for (const k of ['F1', 'F4', 'F2', 'F1', 'F1']) { await page.keyboard.press(k); await page.waitForTimeout(250) }
  const pinned = (await lastBeacon(page))!
  console.log(`[view] engine view mode after F1/F4/F2/F1/F1: ${pinned.view}`)
  expect(pinned.view).toBe(0)

  // Take off, then fly it into the ground.
  for (let i = 0; i < 20; i++) await page.keyboard.press('q')
  await page.keyboard.press('Tab')
  await waitForBeacon(page, (b) => !!b.flight && b.flight[1] > 90, 60_000, 'take-off speed')
  await page.keyboard.down('s'); await page.waitForTimeout(2500); await page.keyboard.up('s')
  await page.keyboard.down('w')
  const dead = await waitForBeacon(page, (b) => b.aircraft.length === 0 || b.aircraft.every((a) => !a.player || !a.alive), 60_000, 'crashed')
  await page.keyboard.up('w')
  console.log(`[crash] aircraft ${JSON.stringify(dead.aircraft.map((a) => ({ alive: a.alive, y: +a.pos[1].toFixed(0) })))} seat ${dead.seat}`)
  // The pilot is stood up and brought back to the apron; the engine is in standby, ready for the kiosk.
  // The dev environment has no teleport, and it respawns a player found
  // under the ground at its own spawn (the origin): a pilot stood up 0.6 m
  // low by the eject ends there as often as beside the parked seat.  Either
  // counts here; the return to the apron is checked on the real host (prod-pc).
  const nearXZ = (f: number[], x: number, z: number) => Math.hypot(f[0] - x, f[2] - z) < 10
  const out = await waitForBeacon(page, (b) => b.seat === null && !!b.net && b.net.state !== NET_FLYING && !!b.ground.feet && (nearXZ(b.ground.feet, apron.spawn[0], apron.spawn[2]) || nearXZ(b.ground.feet, 0, 0)), 30_000, 'not seated, standby, on the apron or at the dev spawn')
  console.log(`[crash] feet ${JSON.stringify(out.ground.feet!.map((n) => +n.toFixed(1)))} net state ${out.net!.state}`)
  const stood = await waitForBeacon(page, (b) => !!b.ground.feet && b.ground.feet[1] > -0.3, 10_000, 'standing on the ground, not in it')
  console.log(`[crash] settled feet ${JSON.stringify(stood.ground.feet!.map((n) => +n.toFixed(2)))}`)
  await page.waitForTimeout(1500)
  const again = await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  expect(again).toBe('requested')
  await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.aircraft.some((a) => a.player && a.alive), 30_000, 'flying again after the crash')
})

test('carrier deck: a pilot who leaves the seat on the deck stands on it', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.apron, 90_000, 'server ready')
  // On the apron the floor under the feet is the field, not a deck.
  const apron = await waitForBeacon(page, (b) => b.ground.field != null, 10_000, 'ground under the feet')
  expect(apron.ground.deck).toBe(false)
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-18C_HORNET', 'ON_CARRIER1'))
  const seated = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.aircraft.some((a) => a.player), 30_000, 'seated on the carrier')
  const air = seated.aircraft.find((a) => a.player)!
  console.log(`[carrier] aircraft at ${JSON.stringify(air.pos.map((n) => +n.toFixed(1)))}`)
  expect(air.pos[1]).toBeGreaterThan(20)
  await page.waitForTimeout(1500)
  await page.keyboard.down('Space'); await page.waitForTimeout(300); await page.keyboard.up('Space')
  await waitForBeacon(page, (b) => b.seat === null, 10_000, 'left the seat')
  await page.waitForTimeout(3000)
  const stood = (await lastBeacon(page))!
  console.log(`[carrier] feet ${JSON.stringify(stood.ground.feet!.map((n) => +n.toFixed(2)))} surface ${stood.ground.field?.toFixed(2)} deck ${stood.ground.deck}`)
  expect(stood.ground.deck).toBe(true)
  expect(Math.abs(stood.ground.feet![1] - stood.ground.field!)).toBeLessThan(0.3)
  expect(stood.ground.feet![1]).toBeGreaterThan(20)
  // Walk a few seconds: still on the deck or, past its edge, down at the sea -- never below the surface.
  await page.keyboard.down('w'); await page.waitForTimeout(2000); await page.keyboard.up('w')
  await page.waitForTimeout(1500)
  const walked = (await lastBeacon(page))!
  console.log(`[carrier] after walking: feet ${JSON.stringify(walked.ground.feet!.map((n) => +n.toFixed(2)))} surface ${walked.ground.field?.toFixed(2)} deck ${walked.ground.deck}`)
  expect(walked.ground.feet![1]).toBeGreaterThan(walked.ground.field! - 0.3)
  await page.screenshot({ path: test.info().outputPath('carrier-deck.png') })
})

// A client whose host never answers (no host in this room): the loading panel
// counts the attempts, then says it gave up instead of sitting at ~90 % for good.
test('loading panel: a client that cannot reach the host is told so', async ({ page }) => {
  await watchBeacon(page)
  await page.goto('http://localhost:5173/?ysfxnet=client:87654321&ysfxstall=4')
  const retrying = await waitForBeacon(page, (b) => !!b.connect && b.connect.tries >= 1 && !b.connect.failed, 60_000, 'second attempt')
  console.log(`[connect] retrying ${JSON.stringify(retrying.connect)} stage ${retrying.load?.stage}`)
  await page.waitForTimeout(600)
  await page.screenshot({ path: test.info().outputPath('connect-retrying.png') })
  const gaveUp = await waitForBeacon(page, (b) => !!b.connect?.failed, 180_000, 'gave up')
  console.log(`[connect] gave up ${JSON.stringify(gaveUp.connect)} stage ${gaveUp.load?.stage}`)
  expect(gaveUp.connect!.tries).toBe(gaveUp.connect!.max - 1)
  expect(gaveUp.load!.stage).not.toBe('ready')
  await page.waitForTimeout(600)
  await page.screenshot({ path: test.info().outputPath('connect-failed.png') })
  // No more restarts once it gave up.
  await page.waitForTimeout(8_000)
  const later = await waitForBeacon(page, (b) => !!b.connect, 2_000, 'still reported')
  expect(later.connect!.tries).toBe(gaveUp.connect!.tries)
  expect(later.connect!.failed).toBe(true)
})
