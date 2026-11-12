/**
 * local-loadout: the kiosk's loading column -- weapons, fuel and smoke picked
 * in the lobby are what the aircraft flies with.  The editor lives in the
 * engine (fsvr.h FsVrLoadout*), so the rules are the original chooser's; the
 * test reads back what the player's aircraft really carries.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345683'
const AIM9 = 1, AGM65 = 2, BOMB = 3, AIM120 = 6
type Editor = NonNullable<NonNullable<Awaited<ReturnType<typeof waitForBeacon>>['loadout']>>['editor']
const slot = (e: Editor, type: number) => e.slots.find((s) => s.type === type)!
const loadout = (page: import('@playwright/test').Page, air: string, changes: Array<[number, number]>, fuel?: number, smoke?: boolean) =>
  page.evaluate(([a, c, f, s]) => (window as unknown as { __ysfxLoadout: (a: string, c: Array<[number, number]>, f?: number, s?: boolean) => Editor }).__ysfxLoadout(a as string, c as Array<[number, number]>, f as number | undefined, s as boolean | undefined), [air, changes, fuel, smoke] as const)

test('loading column: the default, the limits, and a chosen loading reach the aircraft', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.lobby && b.lobby[0] > 10, 90_000, 'server ready, lists loaded')

  // The kiosk loaded the editor with its default aircraft: the column shows buttons for what it can carry.
  const shown = await waitForBeacon(page, (b) => !!b.loadout?.editor.valid && b.kioskItems.some((i) => i.name.startsWith('lo+:')) && b.kioskItems.some((i) => i.name === 'fuel-'), 15_000, 'loading column shown')
  const def = shown.loadout!.editor
  console.log(`[loadout] F-16C default ${JSON.stringify(def.slots.filter((s) => s.max > 0))} fuel ${def.fuel} smoke ${def.smoke}/${def.smokeGenerators}`)
  console.log(`[loadout] column buttons ${shown.kioskItems.filter((i) => /^(lo[+-]:|fuel|smoke)/.test(i.name)).map((i) => i.name).join(' ')}`)
  expect(slot(def, AIM9).max).toBeGreaterThan(0)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: test.info().outputPath('loadout-column.png') })
  expect(def.fuel).toBe(100)

  // Asking for more than the hard points hold is clamped by the engine; zero unloads.
  const over = await loadout(page, 'F-16C_FIGHTINGFALCON', [[AIM9, 99]])
  expect(slot(over, AIM9).num).toBeLessThanOrEqual(slot(over, AIM9).max)
  const none = await loadout(page, 'F-16C_FIGHTINGFALCON', [[AIM9, 0], [AIM120, 0], [AGM65, 0], [BOMB, 0]])
  for (const t of [AIM9, AIM120, AGM65, BOMB]) expect(slot(none, t).num).toBe(0)

  // A chosen loading: two AIM-9, two bombs if the type carries them, 50 % fuel, no smoke.
  const want = await loadout(page, 'F-16C_FIGHTINGFALCON', [[AIM9, 0], [AIM120, 0], [AGM65, 0], [BOMB, 0], [AIM9, 2], [BOMB, 2]], 50, false)
  console.log(`[loadout] chosen ${JSON.stringify(want.slots.filter((s) => s.max > 0))} fuel ${want.fuel}`)
  expect(slot(want, AIM9).num).toBe(2)
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  const fly = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && !!b.loadout?.carried.valid, 30_000, 'flying, carried loading published')
  const carried = fly.loadout!.carried
  const ed = fly.loadout!.editor
  console.log(`[loadout] carried ${JSON.stringify(ed.slots.map((s, k) => [s.type, carried.counts[k]]).filter(([, n]) => n > 0))} fuel ${(carried.fuelFraction * 100).toFixed(1)} % smoke oil ${carried.smokeOilKg.toFixed(1)} kg`)
  ed.slots.forEach((s, k) => expect(carried.counts[k], `weapon type ${s.type}`).toBe(slot(want, s.type).num))
  expect(carried.fuelFraction).toBeGreaterThan(0.45)
  expect(carried.fuelFraction).toBeLessThan(0.51)
  expect(carried.smokeOilKg).toBe(0)

  // Another aircraft without touching the column: its own default, not the F-16's leftovers.
  const other = await loadout(page, 'A-10A_THUNDERBOLT2', [], 100, true)
  console.log(`[loadout] A-10 default ${JSON.stringify(other.slots.filter((s) => s.max > 0))}`)
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('A-10A_THUNDERBOLT2', 'RW01_01'))
  // The F-16 is let go first; the A-10 is another aircraft id.  (The kiosk does not offer a start to a
  // seated pilot, so the dev hook's replacement does not board: only the aircraft is looked at.)
  const first = fly.net!.playerAirId
  const fly2 = await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0 && b.net.playerAirId !== first && !!b.loadout?.carried.valid && b.loadout.carried.fuelFraction > 0.9, 40_000, 'flying the A-10 with full fuel')
  const c2 = fly2.loadout!.carried
  console.log(`[loadout] A-10 carried ${JSON.stringify(fly2.loadout!.editor.slots.map((s, k) => [s.type, c2.counts[k]]).filter(([, n]) => n > 0))} fuel ${(c2.fuelFraction * 100).toFixed(1)} % smoke oil ${c2.smokeOilKg.toFixed(1)} kg`)
  fly2.loadout!.editor.slots.forEach((s, k) => expect(c2.counts[k], `weapon type ${s.type}`).toBe(slot(other, s.type).num))
  await page.screenshot({ path: test.info().outputPath('loadout-kiosk.png') })
})

// The same column by the crosshair, as a desktop visitor uses it: pointer
// lock by a click, aim at a button (its world centre is in the beacon), click.
test('loading column by crosshair: minus takes one AIM-9 off, fuel steps down, smoke toggles', async ({ page }) => {
  const { aimError, walkAndAim, lastBeacon } = await import('./helpers')
  const DEG_PER_PX = 0.115
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  const b0 = await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.loadout?.editor.valid && b.kioskItems.some((i) => i.name === 'lo-:1') && !!b.cam && !!b.apron, 90_000, 'loading column shown')
  const before = b0.loadout!.editor
  await page.mouse.click(640, 360)
  await page.waitForTimeout(800)
  const locked = await page.evaluate(() => !!document.pointerLockElement)
  console.log(`[loadout:click] pointer lock ${locked}`)
  expect(locked).toBe(true)
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
    const aim = await walkAndAim(page, look, walk, 3.2, { id: name, p: item.pos })
    // The buttons are 7.6 cm wide: at 3 m that is 0.7 degree each side.
    let left = await aimError(page, { id: name, p: item.pos })
    for (let it = 0; it < 10 && (Math.abs(left.dyaw) > 0.2 || Math.abs(left.dpitch) > 0.2); it++) {
      await look(left.dyaw * 0.9, left.dpitch * 0.9)
      left = await aimError(page, { id: name, p: item.pos })
    }
    console.log(`[loadout:click] ${name}: ${aim.dist.toFixed(2)} m away, off by ${left.dyaw.toFixed(2)} / ${left.dpitch.toFixed(2)} deg`)
    await page.mouse.click(cur.mx, cur.my)
    await page.waitForTimeout(700)
  }
  const AIM9 = 1
  const n0 = before.slots.find((s) => s.type === AIM9)!.num
  await press('lo-:1')
  await waitForBeacon(page, (b) => b.loadout!.editor.slots.find((s) => s.type === AIM9)!.num === n0 - 1, 8_000, 'one AIM-9 off')
  await press('lo+:1')
  await waitForBeacon(page, (b) => b.loadout!.editor.slots.find((s) => s.type === AIM9)!.num === n0, 8_000, 'and back on')
  await press('fuel-')
  await waitForBeacon(page, (b) => b.loadout!.editor.fuel === before.fuel - 10, 8_000, 'fuel down 10 %')
  await press('smoke')
  const end = await waitForBeacon(page, (b) => b.loadout!.editor.smoke !== before.smoke, 8_000, 'smoke toggled')
  console.log(`[loadout:click] AIM-9 ${n0} -> ${n0 - 1} -> ${n0}, fuel ${before.fuel} -> ${end.loadout!.editor.fuel}, smoke ${before.smoke} -> ${end.loadout!.editor.smoke}`)
  await page.screenshot({ path: test.info().outputPath('loadout-clicked.png') })
})
