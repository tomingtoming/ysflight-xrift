/**
 * local-sign: the controls board stands beside the kiosk once the field is
 * ready.  A screenshot for the eye; the board has nothing to press.
 */
import { test } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'

test('controls sign: visible from the spawn point beside the kiosk', async ({ page }) => {
  await watchBeacon(page)
  await page.goto('http://localhost:5173/?ysfxnet=host:12345678')
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.apron && !!b.kioskBtn && b.load?.stage === 'ready', 90_000, 'field ready')
  await page.waitForTimeout(2500)
  await page.screenshot({ path: test.info().outputPath('local-sign.png') })
})
