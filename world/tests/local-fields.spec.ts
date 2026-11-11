/**
 * local-fields: a survey, not a gate -- every selectable field puts the apron
 * (spawn, kiosk, panel) beside its first runway.  One screenshot per field,
 * for a human or a model to look at.
 */
import { expect, test } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345680'

test('every field: the apron beside the first start position', async ({ page }) => {
  test.setTimeout(900_000)
  await watchBeacon(page)
  page.on('console', (m) => { if (/\[ysfx\] apron/.test(m.text())) console.log(m.text()) })
  page.on('console', (m) => { if (/\[ysfx\] apron/.test(m.text())) console.log(m.text()) })
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  const first = await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.field && b.field.names.length > 0 && !!b.apron, 90_000, 'server ready')
  const only = process.env.YSFX_FIELDS?.split(',')
  for (const f of first.field!.names) {
    if (only && !only.includes(f)) continue
    const before = (await waitForBeacon(page, (x) => !!x.apron, 5_000, 'apron')).apron!.spawn
    const same = f === (await waitForBeacon(page, (x) => !!x.field, 5_000, 'field')).field!.current
    if (!same) await page.evaluate((x) => (window as unknown as { __ysfxSetField: (f: string) => string }).__ysfxSetField(x), f)
    const b = await waitForBeacon(page, (x) => x.field?.current === f && !!x.net && x.net.ready && x.load?.stage === 'ready' && !!x.apron && (same || Math.hypot(x.apron.spawn[0] - before[0], x.apron.spawn[2] - before[2]) > 1) && !!x.kioskBtn && Math.hypot(x.kioskBtn[0] - x.apron.spawn[0], x.kioskBtn[2] - x.apron.spawn[2]) < 10, 120_000, `field ${f} ready`)
    await page.waitForTimeout(2500)
    const s = (await waitForBeacon(page, (x) => !!x.ground.feet, 5_000, 'feet'))
    const feet = s.ground.feet!
    console.log(`[field] ${f} stp ${b.apron!.stp} spawn ${b.apron!.spawn.map((n) => n.toFixed(1)).join(',')} elev ${b.apron!.elev.toFixed(1)} feet ${feet.map((n) => n.toFixed(1)).join(',')} off ${Math.hypot(feet[0] - b.apron!.spawn[0], feet[2] - b.apron!.spawn[2]).toFixed(1)} m`)
    await page.screenshot({ path: test.info().outputPath(`field-${f}.png`) })
    if (process.env.YSFX_TURN) {
      await page.mouse.click(640, 360)
      await page.waitForTimeout(500)
      let mx = 640
      for (let k = 1; k <= 5; k++) {
        mx += 500
        await page.mouse.move(mx, 360, { steps: 20 })
        await page.waitForTimeout(600)
        const c = (await waitForBeacon(page, (x) => !!x.cam, 5_000, 'cam')).cam!
        console.log(`[turn ${k}] quat ${c.quat.map((n) => n.toFixed(2)).join(',')}`)
        await page.screenshot({ path: test.info().outputPath(`field-${f}-turn${k}.png`) })
      }
    }
  }
  expect(true).toBe(true)
})
