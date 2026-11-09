/**
 * prod-pc: the real XRift host, desktop.  Needs tests/.auth/xrift.json
 * (npm run test:auth).  Asserts the world loads, the engine boots and the
 * session elects a role; interaction (sitting) is attempted via the host's
 * crosshair and reported, not required, until Pointer Lock under automation
 * is understood.
 */
import { expect, test } from '@playwright/test'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { enterWorld, waitForBeacon, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

test('world loads and a session role is elected', async ({ page }) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  const b = await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  expect(['host', 'client']).toContain(b.role)
  const drawn = await waitForBeacon(page, (x) => x.draws > 120, 30_000, 'engine drawing')
  test.info().annotations.push({ type: 'gfx', description: JSON.stringify(drawn.gfx) })
  await page.screenshot({ path: test.info().outputPath('prod-pc.png') })
})
