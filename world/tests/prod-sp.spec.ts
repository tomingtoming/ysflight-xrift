/**
 * prod-sp: the real XRift host with a phone profile (Pixel 7: touch, mobile
 * UA).  Drives the real mobile controls through CDP touch events: drag on the
 * view to look, the virtual joystick (bottom-left) to walk and, once seated,
 * to steer, and the "インタラクト" button to sit.  No keyboard, so no
 * throttle -- that is a world-side gap, not a harness one.
 */
import { expect, test } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { aimError, enterWorld, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

const DEG_PER_PX = 0.229 // host touch-look sensitivity, measured 2026-11-09 (Pixel 7 profile)
const JOY: [number, number] = [70, 768] // virtual joystick centre in CSS px (412x839 viewport)

test('phone: walk, sit by interact button, steer by joystick', async ({ page, context }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  expect(b.net!.mode).toBeGreaterThan(0)
  await waitForBeacon(page, (x) => !!x.cam && x.seats.length > 0, 20_000, 'camera + seats')

  const cdp = await context.newCDPSession(page)
  const touchStart = (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  const touchMove = (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  // Finger left turns left (yaw +), finger down pitches down.
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    const x0 = 300, y0 = 300, n = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 15))
    await touchStart(x0, y0)
    for (let i = 1; i <= n; i++) { await page.waitForTimeout(16); await touchMove(x0 + (dx * i) / n, y0 + (dy * i) / n) }
    await touchEnd()
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await touchStart(...JOY); await touchMove(JOY[0], JOY[1] - 45); await page.waitForTimeout(ms); await touchEnd() }
  const aim = await walkAndAim(page, look, walk)
  test.info().annotations.push({ type: 'aim', description: `${aim.id} dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}` })
  await page.screenshot({ path: test.info().outputPath('sp-aimed.png') })

  const interact = page.getByRole('button', { name: 'インタラクト' })
  await expect(interact).toBeEnabled()
  await interact.tap({ force: true })
  const seated = await waitForBeacon(page, (x) => x.seat !== null, 8_000, 'seated after interact')
  expect(seated.seat).toBe(aim.id)
  const flying = await waitForBeacon(page, (x) => !!x.net && x.net.state === NET_FLYING, 40_000, 'flying')
  expect(flying.aircraft.some((a) => a.player)).toBe(true)

  await touchStart(...JOY); await touchMove(JOY[0], JOY[1] - 45)
  const stick = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[2] < -0.5, 10_000, 'stick forward')
  expect(stick.ctl![2]).toBeLessThan(-0.5)
  await touchEnd()
  await waitForBeacon(page, (x) => !!x.ctl && Math.abs(x.ctl[2]) < 0.05, 10_000, 'stick released')
  await page.screenshot({ path: test.info().outputPath('sp-seated.png') })

  // The jump button (held, like Space on desktop) leaves the seat.
  const jump = page.getByRole('button', { name: 'ジャンプ' })
  const jb = (await jump.boundingBox())!
  let left = null as Awaited<ReturnType<typeof waitForBeacon>> | null
  for (let attempt = 0; attempt < 2 && !left; attempt++) {
    await touchStart(jb.x + jb.width / 2, jb.y + jb.height / 2); await page.waitForTimeout(600); await touchEnd()
    left = await waitForBeacon(page, (x) => x.seat === null, 6_000, 'left the seat').catch(() => null)
  }
  if (!left) throw new Error(`still seated after jump hold; last beacon: ${JSON.stringify(await lastBeacon(page))}`)
})

// LobbyKiosk geometry, as in prod-pc.spec.ts.
const KIOSK: [number, number, number] = [-117 + 8, 1.6, 640 + 5]
const START_BTN: [number, number, number] = [KIOSK[0] - (1700 / 2 - 28 - 160) / 1000, KIOSK[1] - (1000 / 2 - 28 - 40) / 1000, KIOSK[2]]

test('phone: kiosk 飛行開始 by the interact button boards the cockpit seat', async ({ page, context }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'kiosk lists')
  await waitForBeacon(page, (x) => !!x.cam, 20_000, 'camera')

  const cdp = await context.newCDPSession(page)
  const touchStart = (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  const touchMove = (x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
  const touchEnd = () => cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    const x0 = 300, y0 = 300, n = Math.max(2, Math.ceil(Math.hypot(dx, dy) / 15))
    await touchStart(x0, y0)
    for (let i = 1; i <= n; i++) { await page.waitForTimeout(16); await touchMove(x0 + (dx * i) / n, y0 + (dy * i) / n) }
    await touchEnd()
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await touchStart(...JOY); await touchMove(JOY[0], JOY[1] - 45); await page.waitForTimeout(ms); await touchEnd() }
  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: START_BTN })
  console.log(`[sp kiosk aim] dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('sp-kiosk.png') })

  const interact = page.getByRole('button', { name: 'インタラクト' })
  const enabled = await interact.isEnabled().catch(() => false)
  console.log(`[sp kiosk] interact button enabled: ${enabled}`)
  await interact.tap({ force: true })
  await page.waitForTimeout(1500)
  console.log(`[sp kiosk] lobby after tap: ${JSON.stringify((await lastBeacon(page))?.lobby)}`)
  const seated = await waitForBeacon(page, (x) => x.seat === 'ysfx-cockpit', 30_000, 'auto-seated after 飛行開始')
  expect(seated.net!.state).toBe(NET_FLYING)
  await waitForBeacon(page, (x) => !!x.hud && /SPD/.test(x.hud[0]), 10_000, 'HUD')
  await page.screenshot({ path: test.info().outputPath('sp-kiosk-flying.png') })

  // The phone's switch panel (TouchConsole) below the HUD: look at a button
  // and tap インタラクト.  THR＋ three times -> throttle 30 %; BRK -> brake on.
  await waitForBeacon(page, (x) => !!x.console && x.console.length === 8, 10_000, 'switch panel shown')
  // The panel rides the aircraft, so re-read the button's world position from
  // the same beacon as the camera on every aiming step.
  const aimConsole = async (id: string) => {
    let e = null as Awaited<ReturnType<typeof aimError>> | null
    for (let it = 0; it < 12; it++) {
      const b = (await lastBeacon(page))!
      e = await aimError(page, { id, p: b.console!.find((c) => c.id === id)!.pos })
      if (Math.abs(e.dyaw) < 1 && Math.abs(e.dpitch) < 1) break
      await look(e.dyaw * 0.8, e.dpitch * 0.8)
    }
    return e!
  }
  // Parked first: BRK toggles the engine's brake flag (flight[10]).
  const brake0 = (await lastBeacon(page))!.flight![10]
  const aimBrk = await aimConsole('console-brk')
  console.log(`[sp console aim] BRK dist ${aimBrk.dist.toFixed(2)} dyaw ${aimBrk.dyaw.toFixed(1)} dpitch ${aimBrk.dpitch.toFixed(1)}`)
  await page.screenshot({ path: test.info().outputPath('sp-console.png') })
  await interact.tap({ force: true })
  const brk = await waitForBeacon(page, (x) => !!x.flight && Math.abs(x.flight[10] - brake0) > 0.5, 10_000, 'brake toggled by the panel')
  console.log(`[sp console] brake ${brake0} -> ${brk.flight![10]}`)
  // Then THR＋ three times -> 30 % (the aircraft starts rolling, so this comes last).
  const aimThr = await aimConsole('console-thr+')
  console.log(`[sp console aim] THR+ dist ${aimThr.dist.toFixed(2)} dyaw ${aimThr.dyaw.toFixed(1)} dpitch ${aimThr.dpitch.toFixed(1)}`)
  for (let i = 0; i < 3; i++) { await interact.tap({ force: true }); await page.waitForTimeout(400) }
  const thr = await waitForBeacon(page, (x) => !!x.flight && x.flight[7] > 0.25, 10_000, 'throttle 30 % from three taps')
  console.log(`[sp console] throttle ${thr.flight![7].toFixed(2)}`)

  const jump = page.getByRole('button', { name: 'ジャンプ' })
  const jb = (await jump.boundingBox())!
  await touchStart(jb.x + jb.width / 2, jb.y + jb.height / 2); await page.waitForTimeout(600); await touchEnd()
  const left = await waitForBeacon(page, (x) => x.seat === null, 8_000, 'left the seat')
  expect(left.seat).toBeNull()
})
