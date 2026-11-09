/**
 * prod-sp: the real XRift host with a phone profile (Pixel 7: touch, mobile
 * UA).  Drives the real mobile controls through CDP touch events: drag on the
 * view to look, the virtual joystick (bottom-left) to walk and, once seated,
 * to steer, and the "インタラクト" button to sit.  No keyboard, so no
 * throttle -- that is a world-side gap, not a harness one.
 */
import { expect, test } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { enterWorld, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

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
