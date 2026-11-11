/**
 * local-pad: a standard gamepad flies the aircraft (engine/gamepadStick.ts).
 * The pad is a fake behind navigator.getGamepads(); what is checked is the
 * path from the pad's axes and buttons to the engine's control block, its
 * flight data, and back to the keyboard when the pad is let go.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, installFakePad, lastBeacon, setPad, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345678'

test('gamepad: sticks, rudder, triggers and buttons fly the aircraft; letting go returns everything to the keys', async ({ page }) => {
  await installFakePad(page)
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'seated and flying')
  await waitForBeacon(page, (b) => !!b.hud && /SPD/.test(b.hud[0]), 15_000, 'hud')

  // No pad yet: nothing connected, the bus has no gamepad owner.
  expect((await lastBeacon(page))!.pad.connected).toBe(false)

  // Left stick right and back: roll right, nose up.  Owner is the gamepad.
  await setPad(page, { on: true, axes: [0.8, 0.8, 0, 0] })
  const s = await waitForBeacon(page, (b) => b.pad.active && b.ctlOwner === 'gamepad' && !!b.ctl && b.ctl[1] > 0.4 && b.ctl[2] > 0.4, 5_000, 'pad stick: right + back')
  console.log(`[pad stick] (0.8, 0.8) -> ail ${s.ctl![1].toFixed(2)} elv ${s.ctl![2].toFixed(2)} rudOwned ${s.ctl![11]}`)
  expect(s.pad.standard).toBe(true)
  expect(s.ctl![11]).toBe(0) // no rudder deflection: Z/X/C keep the rudder

  // Inside the dead zone: the stick is let go and reads neutral (the host's seat input, at rest, holds it from here).
  await setPad(page, { axes: [0.05, -0.05, 0, 0] })
  await waitForBeacon(page, (b) => !b.pad.active && b.ctlOwner !== 'gamepad' && !!b.ctl && Math.abs(b.ctl[1]) < 0.01 && Math.abs(b.ctl[2]) < 0.01, 5_000, 'pad stick centred')

  // Right stick X right: nose right = rudder negative on the bus; the engine's rudder follows.
  await setPad(page, { axes: [0, 0, 0.9, 0] })
  const r = await waitForBeacon(page, (b) => !!b.ctl && b.ctl[11] === 1 && b.ctl[3] < -0.5 && !!b.flight && Math.abs(b.flight[15]) > 0.3, 5_000, 'pad rudder')
  console.log(`[pad rudder] 0.9 -> block ${r.ctl![3].toFixed(2)}, engine ${r.flight![15].toFixed(2)}`)
  // Let go: one frame of zeros centres it, then the rudder is the keys' again.
  await setPad(page, { axes: [0, 0, 0, 0] })
  const r0 = await waitForBeacon(page, (b) => !!b.ctl && b.ctl[11] === 0 && !!b.flight && Math.abs(b.flight[15]) < 0.02, 5_000, 'pad rudder released and centred')
  expect(r0.pad.active).toBe(false)
  await page.keyboard.down('z')
  await page.waitForTimeout(1000)
  const rz = (await lastBeacon(page))!.flight![15]
  await page.keyboard.up('z')
  await page.keyboard.press('x')
  console.log(`[pad -> keys] Z held 1 s after the pad -> rudder ${rz.toFixed(2)}`)
  expect(Math.abs(rz)).toBeGreaterThan(0.2)

  // Right trigger: the throttle climbs while pulled and stays when released.
  await setPad(page, { buttons: { 7: 1 } })
  const t1 = await waitForBeacon(page, (b) => b.pad.throttling && !!b.flight && b.flight[7] > 0.4, 8_000, 'RT raises the throttle')
  expect(t1.ctl![6]).toBe(1)
  await setPad(page, { buttons: { 7: 0 } })
  const t2 = await waitForBeacon(page, (b) => !b.pad.throttling && !!b.ctl && b.ctl[6] === 0, 5_000, 'RT released: throttle back to the keys')
  await page.waitForTimeout(500)
  const kept = (await lastBeacon(page))!.flight![7]
  console.log(`[pad throttle] RT -> ${t1.flight![7].toFixed(2)}, released at ${t2.flight![7].toFixed(2)}, 0.5 s later ${kept.toFixed(2)}`)
  expect(kept).toBeGreaterThan(0.4)
  // ... and the keyboard takes it from there (A = throttle down).
  await page.keyboard.down('a')
  await page.waitForTimeout(700)
  const afterA = (await lastBeacon(page))!.flight![7]
  await page.keyboard.up('a')
  expect(afterA).toBeLessThan(kept - 0.03)
  // Left trigger brings it down.
  await setPad(page, { buttons: { 6: 1 } })
  await waitForBeacon(page, (b) => !!b.flight && b.flight[7] < 0.05, 8_000, 'LT lowers the throttle')
  await setPad(page, { buttons: { 6: 0 } })

  // Buttons: X toggles the brake, Y the gear (taps), A holds the fire key.
  const b0 = (await lastBeacon(page))!
  await setPad(page, { buttons: { 2: 1 } })
  await page.waitForTimeout(200)
  await setPad(page, { buttons: { 2: 0 } })
  const brk = await waitForBeacon(page, (b) => !!b.flight && b.flight[10] !== b0.flight![10], 5_000, 'X toggles the brake')
  console.log(`[pad buttons] brake ${b0.flight![10]} -> ${brk.flight![10]}, keys sent ${brk.pad.keys} (last ${brk.pad.lastKey})`)
  const keys0 = brk.pad.keys
  await setPad(page, { buttons: { 0: 1 } })
  await waitForBeacon(page, (b) => b.pad.keys === keys0 + 1 && b.pad.lastKey === 'Space', 5_000, 'A sends the fire key once')
  await page.waitForTimeout(500)
  expect((await lastBeacon(page))!.pad.keys).toBe(keys0 + 1) // held, not repeated
  await setPad(page, { buttons: { 0: 0 } })

  // Unplugged mid-deflection: everything is released.
  await setPad(page, { axes: [1, 0, 0, 0] })
  await waitForBeacon(page, (b) => b.ctlOwner === 'gamepad', 5_000, 'pad holds again')
  await setPad(page, { on: false })
  await waitForBeacon(page, (b) => !b.pad.connected && b.ctlOwner !== 'gamepad' && !!b.ctl && Math.abs(b.ctl[1]) < 0.01, 5_000, 'pad unplugged: stick neutral')
  await page.screenshot({ path: test.info().outputPath('local-pad.png') })
})
