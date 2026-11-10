/**
 * local-panel: the session panel's commands (what the original standby
 * dialog offered beyond picking an aircraft) reach the engine, in standby
 * and while an aircraft exists, and its console lines come back.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345679'
const cmd = (page: import('@playwright/test').Page, c: number) =>
  page.evaluate((x) => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(x), c)

test('session panel: missions, reports and the console log', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  const panel = await waitForBeacon(page, (b) => !!b.panel && b.panel.buttons.length >= 8, 20_000, 'panel buttons')
  console.log(`[panel] buttons ${panel.panel!.buttons.map((x) => x.name).join(',')}`)
  // The key menu the engine prints at start stays out of the log.
  expect(panel.panel!.log.join('\n')).not.toMatch(/Choose Airplane/)

  // The showroom preview: the engine found the selected aircraft's model and draws it behind the kiosk.
  const pv = await waitForBeacon(page, (b) => !!b.preview && b.preview.radius > 1, 15_000, 'preview aircraft drawn')
  console.log(`[preview] ${pv.preview!.air} radius ${pv.preview!.radius.toFixed(1)} m at ${pv.preview!.pos.map((n) => n.toFixed(1)).join(',')}`)
  await page.waitForTimeout(1200)
  await page.screenshot({ path: test.info().outputPath('local-preview.png') })

  // Standby: start and end the intercept mission.
  expect(await cmd(page, 10)).toBe('queued')
  const on = await waitForBeacon(page, (b) => b.net?.mission === 1 && !!b.panel?.log.some((l) => /INTERCEPT MISSION START/.test(l)), 10_000, 'intercept running')
  console.log(`[panel] log ${JSON.stringify(on.panel!.log)}`)
  await page.screenshot({ path: test.info().outputPath('local-panel-standby.png') })
  await cmd(page, 14)
  await waitForBeacon(page, (b) => b.net?.mission === 0 && !!b.panel?.log.some((l) => /terminated/.test(l)), 10_000, 'mission ended')

  // With an aircraft in the session (the pilot may have walked away from it): close air support, the kill report.
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'flying')
  await cmd(page, 13)
  await waitForBeacon(page, (b) => b.net?.mission === 3, 10_000, 'close air support while flying')
  await cmd(page, 2)
  const rep = await waitForBeacon(page, (b) => !!b.panel?.log.some((l) => /\[Kill Report\]/.test(l)), 10_000, 'kill report')
  console.log(`[panel] log ${JSON.stringify(rep.panel!.log)}`)
  await cmd(page, 15)
  await waitForBeacon(page, (b) => !!b.panel?.log.some((l) => /revived/.test(l)), 10_000, 'ground revived')
  await cmd(page, 14)
  await waitForBeacon(page, (b) => b.net?.mission === 0, 10_000, 'mission ended again')
  await page.screenshot({ path: test.info().outputPath('local-panel.png') })
})
