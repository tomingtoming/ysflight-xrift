/**
 * prod-pc: the real XRift host, desktop Chrome.  Needs tests/.auth/xrift.json
 * (npm run test:auth).  Drives the real desktop controls: pointer lock by a
 * click, mouse look (synthesised mouse moves carry movementX/Y under pointer
 * lock, but never jump the virtual pointer back -- that undoes the look),
 * WASD walk, the kiosk's 飛行開始 by crosshair click, W/S stick, the mouse
 * stick (left button held), Q/A throttle and the other YSFLIGHT keys, Space
 * held to leave.
 */
import { resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { aimError, enterWorld, installFakePad, keepAuth, lastBeacon, NET_FLYING, setPad, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

const DEG_PER_PX = 0.115 // host mouse sensitivity, measured 2026-11-09

// The kiosk's 飛行開始 button centre comes from the beacon (the kiosk is
// placed per field, along the runway of the first start position).

/** Enter the world, lock the pointer, walk to the kiosk, click 飛行開始, wait for the cockpit seat and the HUD. */
async function kioskStart(page: Page) {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  expect(['host', 'client']).toContain(b.role)
  const lobby = await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'kiosk lists')
  console.log(`[lobby:prod] aircraft ${lobby.lobby![0]}, start positions ${lobby.lobby![1]}`)
  const g0 = await waitForBeacon(page, (x) => x.ground?.field != null && !!x.cam, 20_000, 'ground probe + camera')
  console.log(`[ground:prod standing] ${JSON.stringify(g0.ground)}`)

  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)
  const cur = { mx: 640, my: 360 }
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    cur.mx += dx; cur.my += dy
    await page.mouse.move(cur.mx, cur.my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  // The kiosk settles once the engine has answered the apron (start position + elevation).
  const placed = await waitForBeacon(page, (x) => !!x.apron && !!x.kioskBtn, 30_000, 'apron + button position')
  const START_BTN = placed.kioskBtn!
  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: START_BTN })
  console.log(`[kiosk aim] dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('pc-kiosk.png') })

  await page.mouse.click(cur.mx, cur.my)
  const seated = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit', 30_000, 'auto-seated after 飛行開始')
  expect(seated.net!.state).toBe(NET_FLYING)
  const flying = await waitForBeacon(page, (x) => !!x.net && x.net.state === NET_FLYING && x.aircraft.some((a) => a.player), 40_000, 'flying')
  expect(flying.aircraft.some((a) => a.player)).toBe(true)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD')
  return { cur, look, walk }
}

test('desktop: kiosk 飛行開始, W/S and mouse stick, Q/A throttle, camera at speed, Space leaves', async ({ page }) => {
  const { cur } = await kioskStart(page)

  await page.keyboard.down('w')
  const stick = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[2] < -0.5, 10_000, 'stick forward')
  expect(stick.ctl![2]).toBeLessThan(-0.5)
  await page.keyboard.up('w')
  await waitForBeacon(page, (x) => !!x.ctl && Math.abs(x.ctl[2]) < 0.05, 10_000, 'stick released')

  // Mouse stick (pointer locked): hold the left button, travel since the grab
  // is the deflection (250 px = full); release and it springs back.
  await page.mouse.down()
  await page.mouse.move(cur.mx + 150, cur.my, { steps: 10 })
  const ms = await waitForBeacon(page, (x) => x.mouse.grabbed && !!x.ctl && x.ctl[0] === 1 && x.ctl[1] > 0.5, 5_000, 'mouse stick: roll right')
  await page.mouse.move(cur.mx + 150, cur.my - 150, { steps: 10 })
  const mf = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[2] < -0.5, 5_000, 'mouse stick: forward = nose down')
  console.log(`[pc mouse stick] right -> ail ${ms.ctl![1].toFixed(2)}; forward -> elv ${mf.ctl![2].toFixed(2)}`)
  await page.screenshot({ path: test.info().outputPath('pc-mouse-stick.png') })
  await page.mouse.up()
  await waitForBeacon(page, (x) => !x.mouse.grabbed && !!x.ctl && Math.abs(x.ctl[1]) < 0.05 && Math.abs(x.ctl[2]) < 0.05, 5_000, 'mouse stick released')

  for (let i = 0; i < 25; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  const thr = await waitForBeacon(page, (x) => !!x.flight && x.flight[7] > 0.9 && x.flight[1] > 5, 15_000, 'throttle up, rolling')
  expect(thr.flight![7]).toBeGreaterThan(0.9)
  // A is YSFLIGHT's throttle-down key; the host also folds it into the seat's
  // roll axis, which the seat takes back out: throttle drops, no roll.
  await page.waitForTimeout(600) // let the Q presses finish landing
  const before = (await lastBeacon(page))!.flight![7]
  await page.keyboard.down('a')
  await page.waitForTimeout(700)
  const aHeld = (await lastBeacon(page))!
  await page.keyboard.up('a')
  console.log(`[pc A held] throttle ${before.toFixed(2)} -> ${aHeld.flight![7].toFixed(2)}, aileron ${aHeld.ctl![1].toFixed(2)}`)
  expect(aHeld.flight![7]).toBeLessThan(before - 0.03)
  expect(Math.abs(aHeld.ctl![1])).toBeLessThan(0.05)
  // At speed the seated camera must stay on the cockpit: lag.eFrames is the
  // camera's residual lag along the velocity in frames (seatLead.ts).
  const fast = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40, 60_000, 'speed > 40 m/s')
  console.log(`[pc lag:first] speed ${fast.lag!.speed.toFixed(1)} m/s, residual ${fast.lag!.eFrames.toFixed(2)} frames, body lag ${fast.lag!.lagMs.toFixed(1)} ms (frame ${fast.lag!.dtMs.toFixed(1)} ms)`)
  await page.waitForTimeout(1500)
  const settled = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40 && Math.abs(x.lag.eFrames) < 0.3, 10_000, 'camera on the cockpit at speed')
  console.log(`[pc lag:settled] speed ${settled.lag!.speed.toFixed(1)} m/s, residual ${settled.lag!.eFrames.toFixed(2)} frames, body lag ${settled.lag!.lagMs.toFixed(1)} ms, travel jitter ${settled.lag!.jitterCm.toFixed(1)} cm/frame, body-vs-visual shake ${settled.lag!.shakeCm.toFixed(1)} cm, anchored ${settled.lag!.anchored}, body trail ${settled.lag!.trailM.toFixed(2)} m wandering ${settled.lag!.trailShakeCm.toFixed(1)} cm RMS; engine ${settled.engine}`)
  // Desktop first person: the beacon's `cockpit` is the true seat (no visual
  // delay) and the avatar's body trails it by its measured lag x speed; the
  // residual eFrames above is what the visuals are matched to (seatLead.ts).
  const gap = Math.hypot(settled.ground.feet![0] - settled.cockpit![0], settled.ground.feet![2] - settled.cockpit![2])
  const trail = (settled.lag!.lagMs / 1000) * settled.lag!.speed
  console.log(`[pc body] feet-to-seat ${gap.toFixed(2)} m, body lag ${trail.toFixed(2)} m at ${settled.lag!.speed.toFixed(0)} m/s`)
  expect(Math.abs(gap - trail)).toBeLessThan(0.6)
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
  // The aircraft stays, parked (throttle idle, brake on), the player beside it.
  const parked = await waitForBeacon(page, (x) => !!x.net && x.net.state === NET_FLYING && x.aircraft.some((a) => a.player && a.alive) && !!x.flight && x.flight[7] < 0.05 && x.flight[10] > 0.5 && !!x.cockpit, 15_000, 'aircraft parked with the brake on')
  console.log(`[pc parked] throttle ${parked.flight![7].toFixed(2)} brake ${parked.flight![10]} speed ${parked.flight![1].toFixed(1)}`)
  await keepAuth(page.context(), resolve(import.meta.dirname, '.auth/xrift.json'))
})

test('desktop: kiosk seat puts the eye on the cockpit point; B/F/Q/A keys; leave, settle, board the parked aircraft again', async ({ page }) => {
  const { cur, look, walk } = await kioskStart(page)
  // The seat measures the camera 1.0-1.5 s after sitting and moves its origin
  // so the eye lands on the engine's cockpit point (seatEye.ts).
  const eye = await waitForBeacon(page, (x) => !!x.eye && x.eye.n > 0 && Math.abs(x.eye.res[1]) < 0.05 && Math.abs(x.eye.res[2]) < 0.05, 10_000, 'eye on the cockpit point')
  console.log(`[kiosk eye] hip-to-eye ${eye.eye!.dy.toFixed(3)} m, ahead ${(-eye.eye!.dz).toFixed(3)} m, residual ${eye.eye!.res.map((n) => n.toFixed(3)).join(',')}`)
  await page.screenshot({ path: test.info().outputPath('pc-kiosk-flying.png') })
  // YSFLIGHT's keys through the kiosk seat: B brake, F flap down, Q throttle, A throttle back.
  const k0 = (await lastBeacon(page))!.flight!
  await page.keyboard.press('b')
  const kb = await waitForBeacon(page, (x) => !!x.flight && Math.abs(x.flight[10] - k0[10]) > 0.5, 5_000, 'B toggles the brake')
  await page.keyboard.press('f')
  const kf = await waitForBeacon(page, (x) => !!x.flight && x.flight[11] > k0[11] + 0.05, 8_000, 'F lowers the flaps')
  for (let i = 0; i < 10; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  const kq = await waitForBeacon(page, (x) => !!x.flight && x.flight[7] > 0.4, 5_000, 'Q raises the throttle')
  console.log(`[kiosk keys] brake ${k0[10]} -> ${kb.flight![10]}, flap ${k0[11].toFixed(2)} -> ${kf.flight![11].toFixed(2)}, throttle ${k0[7].toFixed(2)} -> ${kq.flight![7].toFixed(2)}; engine keys ${kq.keys.n} last ${kq.keys.last}`)
  // Z/C steer the rudder (flight[15]) while the host's seat input holds the stick (fsvr.h [11]).
  await page.keyboard.down('z')
  await page.waitForTimeout(1000)
  const rz = (await lastBeacon(page))!.flight![15]
  await page.keyboard.up('z')
  await page.keyboard.down('c')
  await page.waitForTimeout(2000)
  const rc = (await lastBeacon(page))!.flight![15]
  await page.keyboard.up('c')
  console.log(`[kiosk rudder] Z held 1 s -> ${rz.toFixed(2)}, then C held 2 s -> ${rc.toFixed(2)}`)
  expect(Math.abs(rz)).toBeGreaterThan(0.2)
  expect(rc).toBeLessThan(rz - 0.2)
  await page.keyboard.press('b')
  for (let i = 0; i < 12; i++) { await page.keyboard.press('a'); await page.waitForTimeout(40) }
  await waitForBeacon(page, (x) => !!x.flight && x.flight[7] < 0.05, 5_000, 'A brings the throttle back')
  // Enter / Backspace / Escape never reach the engine (they would open its
  // invisible 2D dialogs; ESC twice would end the flight).
  await page.waitForTimeout(400) // the beacon is 10 Hz: let the last A land in it
  const n0 = (await lastBeacon(page))!.keys.n
  await page.keyboard.press('Enter'); await page.keyboard.press('Backspace')
  await page.waitForTimeout(400)
  const n1 = (await lastBeacon(page))!.keys.n
  expect(n1).toBe(n0)
  await page.keyboard.press('g')
  await waitForBeacon(page, (x) => x.keys.n > n0 && /KeyG/.test(x.keys.last), 5_000, 'G still reaches the engine after Enter/Backspace')
  await page.keyboard.press('g')

  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  const left = await waitForBeacon(page, (x) => x.seat === null, 8_000, 'left the seat')
  expect(left.seat).toBeNull()
  console.log(`[kiosk after leave] feet ${JSON.stringify(left.ground.feet)}`)
  // Put down at the seat's exit position beside the parked aircraft; the character settles onto the runway.
  await page.waitForTimeout(2500)
  const settled = (await lastBeacon(page))!
  console.log(`[kiosk settled] feet ${JSON.stringify(settled.ground.feet)}`)
  expect(settled.ground.feet![1]).toBeLessThan(0.1)
  // The aircraft stays, parked (throttle idle, brake on, still the player's) ...
  const parked = await waitForBeacon(page, (x) => !!x.net && x.net.state === NET_FLYING && x.aircraft.some((a) => a.player && a.alive) && !!x.flight && x.flight[7] < 0.05 && x.flight[10] > 0.5 && !!x.cockpit, 15_000, 'aircraft parked with the brake on')
  console.log(`[pc parked] throttle ${parked.flight![7].toFixed(2)} brake ${parked.flight![10]} speed ${parked.flight![1].toFixed(1)}`)
  // ... and its cockpit seat can be boarded again from the ground.
  const cp = parked.cockpit!
  const aimBack = await walkAndAim(page, look, walk, 2.4, { id: 'cockpit', p: [cp[0], cp[1] + 0.5, cp[2]] })
  console.log(`[pc reboard aim] dist ${aimBack.dist.toFixed(2)} dyaw ${aimBack.dyaw.toFixed(1)} dpitch ${aimBack.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('pc-reboard.png') })
  await page.mouse.click(cur.mx, cur.my)
  const back = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit', 8_000, 'boarded the parked aircraft again')
  expect(back.net!.state).toBe(NET_FLYING)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD back')
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  await waitForBeacon(page, (x) => x.seat === null, 8_000, 'left again')
})

test('desktop: the host picks another field at the kiosk; everyone restarts there and the apron moves', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  test.skip(b.role !== 'host', 'another browser holds the host seat in this instance')
  const b0 = await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10 && x.field.names.length > 1 && !!x.apron && x.kioskItems.length > 0 && !!x.cam, 30_000, 'lists, fields, apron, kiosk items')
  console.log(`[field:prod] current ${b0.field.current}, apron ${JSON.stringify(b0.apron)}`)
  const pick = b0.field.names.find((n) => /MATSUSHIMA/.test(n)) ?? b0.field.names.find((n) => n !== b0.field.current)!
  const item = b0.kioskItems.find((i) => i.name === pick)
  if (!item) throw new Error(`${pick} is not on the kiosk's first field page: ${b0.kioskItems.map((i) => i.name).join(' ')}`)

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
  const aim = await walkAndAim(page, look, walk, 2.4, { id: pick, p: item.pos })
  console.log(`[field:prod aim] ${pick} dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('pc-field-pick.png') })
  await page.mouse.click(cur.mx, cur.my)
  const b1 = await waitForBeacon(page, (x) => x.field.current === pick && !!x.net && x.net.ready && !!x.apron && Math.hypot(x.apron.spawn[0] - b0.apron!.spawn[0], x.apron.spawn[2] - b0.apron!.spawn[2]) > 150, 150_000, 'engine restarted on the new field, apron placed')
  console.log(`[field:prod] -> ${b1.field.current}: start positions ${b1.lobby?.[1]}, apron ${JSON.stringify(b1.apron)}`)
  // The visitor is brought to the new apron and stands on its ground.
  const here = await waitForBeacon(page, (x) => !!x.ground.feet && Math.hypot(x.ground.feet[0] - b1.apron!.spawn[0], x.ground.feet[2] - b1.apron!.spawn[2]) < 5 && Math.abs(x.ground.feet[1] - b1.apron!.elev) < 0.3, 20_000, 'teleported onto the new apron')
  console.log(`[field:prod] feet ${JSON.stringify(here.ground.feet?.map((n) => +n.toFixed(2)))} engine ground ${here.ground.field}`)
  await page.screenshot({ path: test.info().outputPath('pc-field-apron.png') })
  // And the kiosk works there: 飛行開始 at the new field's first start position.
  await page.waitForTimeout(1200)
  const facing = await aimError(page, { id: 'kiosk-start', p: (await lastBeacon(page))!.kioskBtn! })
  console.log(`[field:prod] facing after the teleport: kiosk button ${facing.dist.toFixed(2)} m away, ${facing.dyaw.toFixed(1)} deg off`)
  const btn = (await waitForBeacon(page, (x) => !!x.kioskBtn && Math.hypot(x.kioskBtn[0] - b1.apron!.spawn[0], x.kioskBtn[2] - b1.apron!.spawn[2]) < 30, 10_000, 'kiosk at the new apron')).kioskBtn!
  const aim2 = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: btn })
  console.log(`[field:prod kiosk aim] dist ${aim2.dist.toFixed(2)} dyaw ${aim2.dyaw.toFixed(1)} dpitch ${aim2.dpitch.toFixed(1)}`)
  await page.mouse.click(cur.mx, cur.my)
  const seated = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit' && !!x.net && x.net.state === NET_FLYING, 40_000, 'flying on the new field')
  expect(seated.aircraft.some((a) => a.player && a.alive)).toBe(true)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD')
  await page.screenshot({ path: test.info().outputPath('pc-field-flying.png') })
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  await waitForBeacon(page, (x) => x.seat === null, 8_000, 'left the seat')
})


test('desktop: the session panel by crosshair: kill report, and for the host a mission started and ended', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready && !!x.panel && x.panel.buttons.length >= 2 && !!x.apron && !!x.cam, 150_000, 'session ready, panel placed')
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
  const press = async (name: string) => {
    const btn = (await lastBeacon(page))!.panel!.buttons.find((x) => x.name === name)
    if (!btn) throw new Error(`no panel button ${name}`)
    let aim = await walkAndAim(page, look, walk, 3.2, { id: name, p: btn.pos })
    // The buttons are a few centimetres tall: aim finer than the kiosk needs.
    for (let i = 0; i < 8 && (Math.abs(aim.dyaw) > 0.3 || Math.abs(aim.dpitch) > 0.3); i++) {
      await look(aim.dyaw, aim.dpitch)
      aim = await aimError(page, { id: name, p: btn.pos })
    }
    console.log(`[panel:prod aim] ${name} dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
    await page.mouse.click(cur.mx, cur.my)
    await page.waitForTimeout(700)
  }
  // The showroom aircraft beside the kiosk: look at it for the record.
  if (b.preview) {
    let e = await aimError(page, { id: 'preview', p: b.preview.pos })
    for (let i = 0; i < 12 && (Math.abs(e.dyaw) > 1 || Math.abs(e.dpitch) > 1); i++) {
      await look(e.dyaw * 0.8, e.dpitch * 0.8)
      e = await aimError(page, { id: 'preview', p: b.preview.pos })
    }
    console.log(`[preview:prod] ${b.preview.air} radius ${b.preview.radius.toFixed(1)} m, ${e.dist.toFixed(1)} m away`)
    expect(b.preview.radius).toBeGreaterThan(1)
    await page.screenshot({ path: test.info().outputPath('pc-preview.png') })
  }
  await press('kills')
  const rep = await waitForBeacon(page, (x) => !!x.panel?.log.some((l) => /\[Kill Report\]/.test(l)), 10_000, 'kill report in the log')
  console.log(`[panel:prod] role ${b.role}, log ${JSON.stringify(rep.panel!.log)}`)
  await page.screenshot({ path: test.info().outputPath('pc-panel.png') })
  if (b.role !== 'host') return
  await press('intercept')
  await waitForBeacon(page, (x) => x.net?.mission === 1, 10_000, 'intercept mission running')
  await page.screenshot({ path: test.info().outputPath('pc-panel-mission.png') })
  // Ending asks for a second press.
  await press('terminate')
  expect((await lastBeacon(page))!.net!.mission).toBe(1)
  await press('terminate')
  await waitForBeacon(page, (x) => x.net?.mission === 0, 10_000, 'mission ended')
})

test('desktop: view keys stay in the cockpit view; a crash stands the pilot up on the apron, ready to fly again', async ({ page }) => {
  test.setTimeout(240_000)
  await kioskStart(page)
  const b0 = (await lastBeacon(page))!
  const apron = b0.apron!
  for (const k of ['F1', 'F4', 'F2', 'F1', 'F1']) { await page.keyboard.press(k); await page.waitForTimeout(250) }
  const pinned = (await lastBeacon(page))!
  console.log(`[pc view] engine view mode after F1/F4/F2/F1/F1: ${pinned.view}`)
  expect(pinned.view).toBe(0)
  for (let i = 0; i < 25; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  await page.keyboard.press('Tab')
  await waitForBeacon(page, (x) => !!x.flight && x.flight[1] > 90, 90_000, 'take-off speed')
  await page.keyboard.down('s'); await page.waitForTimeout(2500); await page.keyboard.up('s')
  await page.keyboard.down('w')
  const dead = await waitForBeacon(page, (x) => x.aircraft.length === 0 || x.aircraft.every((a) => !a.player || !a.alive), 90_000, 'crashed')
  await page.keyboard.up('w')
  console.log(`[pc crash] aircraft ${JSON.stringify(dead.aircraft.map((a) => ({ alive: a.alive, y: +a.pos[1].toFixed(0) })))} seat ${dead.seat}`)
  const out = await waitForBeacon(page, (x) => x.seat === null && !!x.net && x.net.state !== NET_FLYING && !!x.ground.feet && Math.hypot(x.ground.feet[0] - apron.spawn[0], x.ground.feet[2] - apron.spawn[2]) < 10, 40_000, 'on the apron, not seated, standby')
  const settled = await waitForBeacon(page, (x) => x.seat === null && !!x.ground.feet && Math.abs(x.ground.feet[1] - apron.elev) < 0.3 && Math.hypot(x.ground.feet[0] - apron.spawn[0], x.ground.feet[2] - apron.spawn[2]) < 3, 10_000, 'standing on the apron')
  console.log(`[pc crash] feet ${JSON.stringify(settled.ground.feet!.map((n) => +n.toFixed(2)))} net state ${out.net!.state} seat ${settled.seat}`)
  expect(Math.abs(settled.ground.feet![1] - apron.elev)).toBeLessThan(0.3)
  await page.screenshot({ path: test.info().outputPath('pc-after-crash.png') })
})

test('desktop: carrier start; leaving the seat on the deck, the pilot stands on it', async ({ page }) => {
  test.setTimeout(240_000)
  const { cur, look, walk } = await kioskStart(page)
  // The first flight came from the kiosk's default start position.  Leave it,
  // pick ON_CARRIER1 in the list and start again.
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  await waitForBeacon(page, (x) => x.seat === null, 10_000, 'left the seat')
  const item = (await waitForBeacon(page, (x) => !!x.kioskItems && x.kioskItems.some((i) => i.name === 'ON_CARRIER1'), 10_000, 'ON_CARRIER1 in the kiosk list').catch(() => null))?.kioskItems?.find((i) => i.name === 'ON_CARRIER1')
  test.skip(!item, 'the kiosk beacon does not list start positions')
  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'ON_CARRIER1', p: item!.pos })
  console.log(`[pc carrier] list aim dist ${aim.dist.toFixed(2)}`)
  await page.mouse.click(cur.mx, cur.my)
  const btn = (await lastBeacon(page))!.kioskBtn!
  await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: btn })
  await page.mouse.click(cur.mx, cur.my)
  const seated = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit' && x.aircraft.some((a) => a.player && a.alive && a.pos[1] > 20), 60_000, 'seated on the carrier')
  console.log(`[pc carrier] aircraft at ${JSON.stringify(seated.aircraft.find((a) => a.player)!.pos.map((n) => +n.toFixed(1)))}`)
  await page.waitForTimeout(1500)
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  await waitForBeacon(page, (x) => x.seat === null, 10_000, 'left the seat on the deck')
  await page.waitForTimeout(3000)
  const stood = (await lastBeacon(page))!
  console.log(`[pc carrier] feet ${JSON.stringify(stood.ground.feet!.map((n) => +n.toFixed(2)))} surface ${stood.ground.field?.toFixed(2)} deck ${stood.ground.deck}`)
  expect(stood.ground.deck).toBe(true)
  expect(Math.abs(stood.ground.feet![1] - stood.ground.field!)).toBeLessThan(0.3)
  await page.screenshot({ path: test.info().outputPath('pc-carrier-deck.png') })
})

// A measurement, not a gate (YSFX_TRACE=1): frame by frame at speed, where
// the simulation has the aircraft, where the host has the camera, where it
// has the body.  Run headed on a 120 Hz display, or with YSFX_ARGS to lift
// the frame-rate cap, to see what a pilot on such a display sees.
test('desktop: Shift and the right button fire; a gamepad flies the aircraft on the real host (stick, rudder, trigger throttle, fire); the pilot stays seated', async ({ page }) => {
  // A fake standard pad behind navigator.getGamepads(): the real host sees it
  // too, so this also records what the host itself does with a pad (does it
  // look around with the right stick, does A stand the pilot up).
  await installFakePad(page)
  const { cur } = await kioskStart(page)
  // Keyboard and mouse first: Shift and the right button fire (Space is the
  // host's "stand up"), and the host must leave the pilot seated through both.
  const gun = (b: { hud: string[] | null }) => Number(/GUN\s+(\d+)/.exec((b.hud ?? []).join(' '))?.[1] ?? NaN)
  const g0 = gun((await lastBeacon(page))!)
  await page.keyboard.down('Shift')
  await waitForBeacon(page, (b) => b.fire.held, 5_000, 'Shift holds the fire key')
  await page.waitForTimeout(700)
  await page.keyboard.up('Shift')
  const g1 = gun(await waitForBeacon(page, (b) => !b.fire.held, 5_000, 'Shift released'))
  await page.mouse.move(cur.mx, cur.my)
  await page.mouse.down({ button: 'right' })
  await waitForBeacon(page, (b) => b.fire.held && b.mouse.fire, 5_000, 'right button holds the fire key')
  await page.waitForTimeout(700)
  await page.mouse.up({ button: 'right' })
  await waitForBeacon(page, (b) => !b.fire.held, 5_000, 'right button released')
  await page.waitForTimeout(600)
  const f = (await lastBeacon(page))!
  console.log(`[fire:prod] gun rounds ${g0} -> Shift -> ${g1} -> right button -> ${gun(f)}; seat ${f.seat}, pointer lock ${await page.evaluate(() => !!document.pointerLockElement)}`)
  expect(g1).toBeLessThan(g0)
  expect(gun(f)).toBeLessThan(g1)
  expect(f.seat).toBe('ysfx-cockpit')
  const cam0 = (await lastBeacon(page))!.cam!.quat
  await setPad(page, { on: true, axes: [0.8, 0.8, 0, 0] })
  const s = await waitForBeacon(page, (b) => b.pad.active && b.ctlOwner === 'gamepad' && !!b.ctl && b.ctl[1] > 0.4 && b.ctl[2] > 0.4, 8_000, 'pad stick: right + back')
  console.log(`[pad:prod stick] ail ${s.ctl![1].toFixed(2)} elv ${s.ctl![2].toFixed(2)}`)
  await setPad(page, { axes: [0, 0, 0.9, 0] })
  const r = await waitForBeacon(page, (b) => !!b.ctl && b.ctl[11] === 1 && b.ctl[3] < -0.5, 8_000, 'pad rudder')
  await page.waitForTimeout(1000)
  const cam1 = (await lastBeacon(page))!.cam!.quat
  const dot = Math.abs(cam0[0] * cam1[0] + cam0[1] * cam1[1] + cam0[2] * cam1[2] + cam0[3] * cam1[3])
  console.log(`[pad:prod rudder] block ${r.ctl![3].toFixed(2)}; camera turned ${(2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(1)} deg while the sticks were held (host look, if any)`)
  await setPad(page, { axes: [0, 0, 0, 0] })
  await waitForBeacon(page, (b) => !b.pad.active && !!b.ctl && b.ctl[11] === 0, 8_000, 'pad released')
  await setPad(page, { buttons: { 7: 1 } })
  const t = await waitForBeacon(page, (b) => !!b.flight && b.flight[7] > 0.4, 10_000, 'RT raises the throttle')
  await setPad(page, { buttons: { 7: 0 } })
  await waitForBeacon(page, (b) => !!b.ctl && b.ctl[6] === 0, 8_000, 'throttle back to the keys')
  console.log(`[pad:prod throttle] ${t.flight![7].toFixed(2)}`)
  // A held for 2 s: the fire key goes out once, and the host must not take it for "stand up".
  const k0 = (await lastBeacon(page))!.pad.keys
  await setPad(page, { buttons: { 0: 1 } })
  await page.waitForTimeout(2000)
  await setPad(page, { buttons: { 0: 0 } })
  const a = (await lastBeacon(page))!
  console.log(`[pad:prod A held 2 s] keys ${k0} -> ${a.pad.keys} (last ${a.pad.lastKey}), seat ${a.seat}`)
  expect(a.pad.keys).toBe(k0 + 1)
  expect(a.seat).toBe('ysfx-cockpit')
  await page.screenshot({ path: test.info().outputPath('pc-pad.png') })
  await keepAuth(page.context(), resolve(import.meta.dirname, '.auth/xrift.json'))
})

test('desktop: the controls sign stands left of the kiosk (screenshot for the eye)', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready && !!x.apron && !!x.kioskBtn, 150_000, 'session ready, apron placed')
  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)
  await page.mouse.move(640 - 33 / DEG_PER_PX, 360, { steps: 15 }) // look 33 deg left
  await page.waitForTimeout(1200)
  await page.screenshot({ path: test.info().outputPath('pc-sign.png') })
  await keepAuth(page.context(), resolve(import.meta.dirname, '.auth/xrift.json'))
})

test('trace: aircraft, camera and body frame by frame at speed', async ({ page }) => {
  test.skip(!process.env.YSFX_TRACE, 'measurement only')
  test.setTimeout(300_000)
  await kioskStart(page)
  if (process.env.YSFX_TRACE_KEY) { await page.keyboard.press(process.env.YSFX_TRACE_KEY); await page.waitForTimeout(500) }
  if (process.env.YSFX_CAM_ANCHOR) await page.evaluate((v) => { (window as unknown as { __ysfxCamAnchor: string }).__ysfxCamAnchor = v }, process.env.YSFX_CAM_ANCHOR)
  if (process.env.YSFX_TRACE_WHEEL) { await page.mouse.wheel(0, Number(process.env.YSFX_TRACE_WHEEL)); await page.waitForTimeout(1200) } // third person
  for (let i = 0; i < 25; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  await page.keyboard.press('Tab')
  await waitForBeacon(page, (x) => !!x.flight && x.flight[1] > 55, 90_000, 'speed')
  // Rolling input while the trace runs.
  await page.screenshot({ path: test.info().outputPath('trace-view.png') })
  // Straight ahead on the runway: any manoeuvre at this speed ends in a crash and a broken record.
  // What actually reaches the screen: a burst of screenshots at speed.  If the camera, the drawn aircraft and the
  // avatar are locked together, the aircraft and the avatar are the same pixels in every shot (compare offline).
  if (process.env.YSFX_SHOTS) {
    const fsx = await import('node:fs')
    fsx.mkdirSync(process.env.YSFX_SHOTS, { recursive: true })
    for (let i = 0; i < 10; i++) { await page.screenshot({ path: `${process.env.YSFX_SHOTS}/shot-${i}.png` }); await page.waitForTimeout(37) }
  }
  await page.evaluate(() => { (window as unknown as { __ysfxTrace: number }).__ysfxTrace = 300 })
  await page.waitForFunction(() => !!(window as unknown as { __ysfxTraceData?: unknown }).__ysfxTraceData, null, { timeout: 60_000 })
  const rows = await page.evaluate(() => (window as unknown as { __ysfxTraceData: number[][] }).__ysfxTraceData)
  { const b = (await lastBeacon(page))!; const d = b.cam && b.cockpit ? Math.hypot(b.cam.pos[0] - b.cockpit[0], b.cam.pos[1] - b.cockpit[1], b.cam.pos[2] - b.cockpit[2]) : NaN; console.log(`[trace] beacon lag ${JSON.stringify(b.lag)}; camera to seat point ${d.toFixed(2)} m; anchor switch ${await page.evaluate(() => String((window as unknown as { __ysfxCamAnchor?: string }).__ysfxCamAnchor))}`) }
  const fs = await import('node:fs')
  fs.writeFileSync(test.info().outputPath('trace.json'), JSON.stringify(rows))
  const n = rows.length
  const a0 = rows[0], a1 = rows[n - 1]
  const d = [a1[2] - a0[2], a1[3] - a0[3], a1[4] - a0[4]]
  const L = Math.hypot(d[0], d[1], d[2])
  const u = d.map((x) => x / L)
  const along = (r: number[], k: number) => (r[k] - a0[2]) * u[0] + (r[k + 1] - a0[3]) * u[1] + (r[k + 2] - a0[4]) * u[2]
  const st = (v: number[]) => { const m = v.reduce((p, c) => p + c, 0) / v.length; return { mean: m, sd: Math.sqrt(v.reduce((p, c) => p + (c - m) ** 2, 0) / v.length), min: Math.min(...v), max: Math.max(...v) } }
  const fmt = (s: { mean: number; sd: number; min: number; max: number }, k = 1) => `mean ${(s.mean * k).toFixed(2)} sd ${(s.sd * k).toFixed(2)} min ${(s.min * k).toFixed(2)} max ${(s.max * k).toFixed(2)}`
  const dts: number[] = [], wall: number[] = [], sa: number[] = [], sc: number[] = [], sf: number[] = []
  for (let i = 1; i < n; i++) {
    dts.push(rows[i][0] - rows[i - 1][0]); wall.push(rows[i][1] - rows[i - 1][1])
    sa.push(along(rows[i], 2) - along(rows[i - 1], 2)); sc.push(along(rows[i], 5) - along(rows[i - 1], 5)); sf.push(along(rows[i], 8) - along(rows[i - 1], 8))
  }
  const lagC = rows.map((r) => along(r, 2) - along(r, 5)), lagF = rows.map((r) => along(r, 2) - along(r, 8))
  const dLagC = lagC.slice(1).map((x, i) => x - lagC[i]), dLagF = lagF.slice(1).map((x, i) => x - lagF[i])
  const speed = L / ((a1[0] - a0[0]) / 1000)
  console.log(`[trace] ${n} frames, speed ${speed.toFixed(1)} m/s`)
  console.log(`[trace] frame clock dt ms: ${fmt(st(dts))}; wall dt ms: ${fmt(st(wall))}`)
  console.log(`[trace] per-frame travel cm -- aircraft: ${fmt(st(sa), 100)}; camera: ${fmt(st(sc), 100)}; body: ${fmt(st(sf), 100)}`)
  console.log(`[trace] frames the body did not move: ${sf.filter((x) => Math.abs(x) < 1e-4).length}/${sf.length}; camera did not move: ${sc.filter((x) => Math.abs(x) < 1e-4).length}/${sc.length}`)
  console.log(`[trace] aircraft ahead of camera, cm: ${fmt(st(lagC), 100)}; frame-to-frame change sd ${(st(dLagC).sd * 100).toFixed(2)}`)
  console.log(`[trace] aircraft ahead of body, cm: ${fmt(st(lagF), 100)}; frame-to-frame change sd ${(st(dLagF).sd * 100).toFixed(2)}`)
  // What the pilot sees: the drawn own aircraft against the camera, and the avatar (body) against the drawn aircraft.
  const visC = rows.map((r) => along(r, 19) - along(r, 5)), visF = rows.map((r) => along(r, 19) - along(r, 8))
  const dVisC = visC.slice(1).map((x, i) => x - visC[i]), dVisF = visF.slice(1).map((x, i) => x - visF[i])
  const camF = rows.map((r) => along(r, 5) - along(r, 8)), dCamF = camF.slice(1).map((x, i) => x - camF[i])
  console.log(`[trace] SEEN  cam anchor ${process.env.YSFX_CAM_ANCHOR ?? 'default'}, wheel ${process.env.YSFX_TRACE_WHEEL ?? 0}: drawn aircraft vs camera, frame-to-frame sd ${(st(dVisC).sd * 100).toFixed(2)} cm (max ${(Math.max(...dVisC.map(Math.abs)) * 100).toFixed(1)}); avatar vs drawn aircraft sd ${(st(dVisF).sd * 100).toFixed(2)} cm (max ${(Math.max(...dVisF.map(Math.abs)) * 100).toFixed(1)}); avatar vs camera sd ${(st(dCamF).sd * 100).toFixed(2)} cm (max ${(Math.max(...dCamF.map(Math.abs)) * 100).toFixed(1)})`)
  const ang = (q1: number[], q2: number[]) => { const d = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]); return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI }
  const rel = rows.slice(1).map((r, i) => ang(r.slice(11, 15), rows[i].slice(11, 15)))
  const air = rows.slice(1).map((r, i) => ang(r.slice(15, 19), rows[i].slice(15, 19)))
  console.log(`[trace] aircraft attitude change per frame, deg: ${fmt(st(air))}; camera attitude in the aircraft frame, change per frame, deg: ${fmt(st(rel))}`)
  console.log(`[trace] attitude, first frames (aircraft deg / camera-in-aircraft deg): ${air.slice(0, 16).map((x, i) => `${x.toFixed(2)}/${rel[i].toFixed(2)}`).join('  ')}`)
  console.log(`[trace] first frames (dt ms | travel cm aircraft/camera/body): ${dts.slice(0, 16).map((t, i) => `${t.toFixed(1)}|${(sa[i] * 100).toFixed(0)}/${(sc[i] * 100).toFixed(0)}/${(sf[i] * 100).toFixed(0)}`).join('  ')}`)
})

test('desktop: the loading column by crosshair -- one AIM-9 off, less fuel -- and the aircraft flies with it; the apron floor is the heightfield', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  // The ground under the visitor is the engine's terrain as a heightfield (net/GroundPatch.tsx), and they stand on it.
  const g = await waitForBeacon(page, (x) => !!x.apron && !!x.ground.patch && x.ground.field != null && !!x.ground.feet && Math.abs(x.ground.feet[1] - x.ground.field) < 0.1, 40_000, 'standing on the heightfield, level with the engine ground')
  console.log(`[loadout:prod] ground ${JSON.stringify(g.ground)}`)
  const b0 = await waitForBeacon(page, (x) => !!x.loadout?.editor.valid && x.kioskItems.some((i) => i.name === 'lo-:1') && x.kioskItems.some((i) => i.name === 'fuel-') && !!x.kioskBtn && !!x.cam, 30_000, 'loading column shown')
  const AIM9 = 1
  const before = b0.loadout!.editor
  const n0 = before.slots.find((s) => s.type === AIM9)!.num
  console.log(`[loadout:prod] default ${JSON.stringify(before.slots.filter((s) => s.max > 0))} fuel ${before.fuel}`)
  expect(n0).toBeGreaterThan(0)

  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)
  const cur = { mx: 640, my: 360 }
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    cur.mx += dx; cur.my += dy
    await page.mouse.move(cur.mx, cur.my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  const press = async (name: string) => {
    const item = (await lastBeacon(page))!.kioskItems.find((i) => i.name === name)
    if (!item) throw new Error(`${name} is not in the loading column`)
    const aim = await walkAndAim(page, look, walk, 3.0, { id: name, p: item.pos })
    console.log(`[loadout:prod aim] ${name} dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
    await page.mouse.click(cur.mx, cur.my)
    await page.waitForTimeout(700)
  }
  await press('lo-:1')
  const one = await waitForBeacon(page, (x) => x.loadout!.editor.slots.find((s) => s.type === AIM9)!.num === n0 - 1, 8_000, 'one AIM-9 off')
  await press('fuel-')
  await press('fuel-')
  const fueled = await waitForBeacon(page, (x) => x.loadout!.editor.fuel === before.fuel - 20, 8_000, 'fuel down 20 %')
  await page.screenshot({ path: test.info().outputPath('pc-loadout.png') })
  const want = fueled.loadout!.editor
  expect(one.loadout!.editor.rev).toBeGreaterThan(before.rev)

  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: (await lastBeacon(page))!.kioskBtn! })
  console.log(`[loadout:prod kiosk aim] dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.mouse.click(cur.mx, cur.my)
  const fly = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit' && !!x.net && x.net.state === NET_FLYING && !!x.loadout?.carried.valid, 40_000, 'flying, carried loading published')
  const c = fly.loadout!.carried
  console.log(`[loadout:prod] carried ${JSON.stringify(want.slots.map((s, k) => [s.type, c.counts[k]]).filter(([, n]) => n > 0))} fuel ${(c.fuelFraction * 100).toFixed(1)} %`)
  want.slots.forEach((s, k) => expect(c.counts[k], `weapon type ${s.type}`).toBe(s.num))
  expect(Math.abs(c.fuelFraction * 100 - want.fuel)).toBeLessThan(3)
  await keepAuth(page.context(), resolve(import.meta.dirname, '.auth/xrift.json'))
})
