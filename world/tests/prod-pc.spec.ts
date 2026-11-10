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
import { aimError, enterWorld, keepAuth, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

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
  const pick = b0.field.names.find((n) => /NAHA/.test(n)) ?? b0.field.names.find((n) => n !== b0.field.current)!
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
