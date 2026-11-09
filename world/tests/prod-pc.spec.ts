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
  const g0 = await waitForBeacon(page, (x) => x.ground?.field != null, 20_000, 'ground probe (needs world >= 15)')
  console.log(`[ground:prod standing] ${JSON.stringify(g0.ground)}`)

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
  console.log(`[ground:prod at pedestal] ${JSON.stringify((await lastBeacon(page))?.ground)}`)
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

  // Mouse stick (pointer locked): hold the left button, travel since the grab
  // is the deflection (250 px = full); release and it springs back.
  await page.mouse.down()
  await page.mouse.move(mx + 150, my, { steps: 10 })
  const ms = await waitForBeacon(page, (x) => x.mouse.grabbed && !!x.ctl && x.ctl[0] === 1 && x.ctl[1] > 0.5, 5_000, 'mouse stick: roll right')
  await page.mouse.move(mx + 150, my - 150, { steps: 10 })
  const mf = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[2] < -0.5, 5_000, 'mouse stick: forward = nose down')
  console.log(`[pc mouse stick] right -> ail ${ms.ctl![1].toFixed(2)}; forward -> elv ${mf.ctl![2].toFixed(2)}`)
  await page.screenshot({ path: test.info().outputPath('pc-mouse-stick.png') })
  await page.mouse.up()
  await waitForBeacon(page, (x) => !x.mouse.grabbed && !!x.ctl && Math.abs(x.ctl[1]) < 0.05 && Math.abs(x.ctl[2]) < 0.05, 5_000, 'mouse stick released')
  mx += 150; my -= 150

  for (let i = 0; i < 25; i++) { await page.keyboard.press('q'); await page.waitForTimeout(40) }
  const thr = await waitForBeacon(page, (x) => !!x.flight && x.flight[7] > 0.9 && x.flight[1] > 5, 15_000, 'throttle up, rolling')
  expect(thr.flight![7]).toBeGreaterThan(0.9)
  // A is YSFLIGHT's throttle-down key; the host also folds it into the seat's
  // roll axis, which the seat takes back out: throttle drops, no roll.
  await page.keyboard.down('a')
  await page.waitForTimeout(700)
  const aHeld = (await lastBeacon(page))!
  await page.keyboard.up('a')
  console.log(`[pc A held] throttle ${thr.flight![7].toFixed(2)} -> ${aHeld.flight![7].toFixed(2)}, aileron ${aHeld.ctl![1].toFixed(2)}`)
  expect(aHeld.flight![7]).toBeLessThan(thr.flight![7] - 0.03)
  expect(Math.abs(aHeld.ctl![1])).toBeLessThan(0.05)
  // At speed the seated camera must stay on the cockpit: lag.eFrames is the
  // camera's residual lag along the velocity in frames (seatLead.ts).
  const fast = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40, 60_000, 'speed > 40 m/s')
  console.log(`[pc lag:first] speed ${fast.lag!.speed.toFixed(1)} m/s, camera lag ${fast.lag!.eFrames.toFixed(2)} frames, lead ${fast.lag!.leadMs.toFixed(1)} ms`)
  await page.waitForTimeout(1500)
  const settled = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40 && Math.abs(x.lag.eFrames) < 0.3, 10_000, 'camera on the cockpit at speed')
  console.log(`[pc lag:settled] speed ${settled.lag!.speed.toFixed(1)} m/s, camera lag ${settled.lag!.eFrames.toFixed(2)} frames, lead ${settled.lag!.leadMs.toFixed(1)} ms`)
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

// LobbyKiosk geometry (World.tsx / LobbyKiosk.tsx): panel centre, yaw PI,
// 1700x1000 px at 1 mm/px, 28 px padding, 飛行開始 button 320x80 at the
// bottom-right.  Local +x maps to world -x under the yaw.
const KIOSK: [number, number, number] = [-117 + 8, 1.6, 640 + 5]
const START_BTN: [number, number, number] = [KIOSK[0] - (1700 / 2 - 28 - 160) / 1000, KIOSK[1] - (1000 / 2 - 28 - 40) / 1000, KIOSK[2]]

test('desktop: kiosk 飛行開始 boards the cockpit seat', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  const lobby = await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'kiosk lists')
  console.log(`[lobby:prod] aircraft ${lobby.lobby![0]}, start positions ${lobby.lobby![1]}`)

  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  let mx = 640, my = 360
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    mx += dx; my += dy
    await page.mouse.move(mx, my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: START_BTN })
  console.log(`[kiosk aim] dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('pc-kiosk.png') })

  await page.mouse.click(mx, my)
  const seated = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit', 30_000, 'auto-seated after 飛行開始')
  expect(seated.net!.state).toBe(NET_FLYING)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD')
  // The seat measures the camera 1.0-1.5 s after sitting and moves its origin
  // so the eye lands on the engine's cockpit point (seatEye.ts).
  const eye = await waitForBeacon(page, (x) => !!x.eye && x.eye.n > 0 && Math.abs(x.eye.res[1]) < 0.05 && Math.abs(x.eye.res[2]) < 0.05, 10_000, 'eye on the cockpit point')
  console.log(`[kiosk eye] hip-to-eye ${eye.eye!.dy.toFixed(3)} m, ahead ${(-eye.eye!.dz).toFixed(3)} m, residual ${eye.eye!.res.map((n) => n.toFixed(3)).join(',')}`)
  await page.screenshot({ path: test.info().outputPath('pc-kiosk-flying.png') })
  await page.keyboard.down('Space'); await page.waitForTimeout(600); await page.keyboard.up('Space')
  const left = await waitForBeacon(page, (x) => x.seat === null, 8_000, 'left the seat')
  expect(left.seat).toBeNull()
  console.log(`[kiosk after leave] feet ${JSON.stringify(left.ground.feet)}`)
  // Teleported home above the apron; the character settles onto the ground.
  await page.waitForTimeout(2500)
  const settled = (await lastBeacon(page))!
  console.log(`[kiosk settled] feet ${JSON.stringify(settled.ground.feet)}`)
  expect(settled.ground.feet![1]).toBeLessThan(0.1)
})
