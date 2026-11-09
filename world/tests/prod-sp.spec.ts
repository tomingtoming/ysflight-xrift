/**
 * prod-sp: the real XRift host with a phone profile (Pixel 7: touch, mobile UA).
 * Asserts the world loads and the engine boots under the mobile UI.
 */
import { expect, test } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { enterWorld, waitForBeacon, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

test('world loads on a phone profile', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  expect(b.net!.mode).toBeGreaterThan(0)
  await page.screenshot({ path: test.info().outputPath('prod-sp.png') })
})
