/**
 * local-multi: host tab + client tab in the dev environment (forced roles
 * via ?ysfxnet=), both starting a flight through the kiosk hook.  Needs
 * local WebRTC P2P (WARP off).
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

// Contexts made with browser.newContext() outlive the test unless closed:
// a leftover host from the previous test kept its room and rejected the next
// client's join (start position taken) -- hence one room per test and an
// explicit close.
const ROOMS = ['23456789', '34567891', '45678912']
const open: Array<{ close: () => Promise<void> }> = []
test.afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())) })
async function pilot(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext()
  open.push(ctx)
  const page = await ctx.newPage()
  await watchBeacon(page)
  return page
}

test('host + client: both fly from the kiosk, each sees the other', async ({ browser }) => {
  test.setTimeout(300_000)
  const host = await pilot(browser)
  await host.goto(`http://localhost:5173/?ysfxnet=host:${ROOMS[0]}`)
  await waitForBeacon(host, (b) => b.role === 'host' && !!b.net && b.net.ready, 90_000, 'server ready')

  const client = await pilot(browser)
  await client.goto(`http://localhost:5173/?ysfxnet=client:${ROOMS[0]}`)
  const cr = await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready, 90_000, 'client connected')
  console.log(`[local-multi] client net ${JSON.stringify(cr.net)}`)
  await waitForBeacon(client, (b) => !!b.lobby && b.lobby[0] > 10, 30_000, 'client lobby lists')

  await client.evaluate(([a, s]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => void }).__ysfxLobbyStart(a, s), ['F-16C_FIGHTINGFALCON', 'RW01_02'])
  const cf = await waitForBeacon(client, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'client flying')
  console.log(`[local-multi] client aircraft ${JSON.stringify(cf.aircraft.find((a) => a.player))}`)
  const hs = await waitForBeacon(host, (b) => b.aircraft.some((a) => a.alive && !a.player), 30_000, 'host sees client aircraft')
  console.log(`[local-multi] host sees ${JSON.stringify(hs.aircraft)}`)

  await host.evaluate(([a, s]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => void }).__ysfxLobbyStart(a, s), ['F-16C_FIGHTINGFALCON', 'RW01_01'])
  await waitForBeacon(host, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'host flying')
  const cs = await waitForBeacon(client, (b) => b.aircraft.filter((a) => a.alive).length >= 2, 30_000, 'client sees two aircraft')
  console.log(`[local-multi] client sees ${JSON.stringify(cs.aircraft)}`)
  expect(cs.aircraft.filter((a) => a.alive).length).toBeGreaterThanOrEqual(2)
})

test('host flies first, then the client joins from the kiosk', async ({ browser }) => {
  test.setTimeout(300_000)
  const go = ([a, s]: string[]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => void }).__ysfxLobbyStart(a, s)
  const host = await pilot(browser)
  await host.goto(`http://localhost:5173/?ysfxnet=host:${ROOMS[1]}`)
  await waitForBeacon(host, (b) => b.role === 'host' && !!b.net && b.net.ready, 90_000, 'server ready')
  await host.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
  await waitForBeacon(host, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'host flying')

  const client = await pilot(browser)
  await client.goto(`http://localhost:5173/?ysfxnet=client:${ROOMS[1]}`)
  await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready, 90_000, 'client connected')
  await waitForBeacon(client, (b) => b.aircraft.some((a) => a.alive && !a.player), 30_000, 'client sees host aircraft')
  await waitForBeacon(client, (b) => !!b.lobby && b.lobby[0] > 10, 30_000, 'client lobby lists')
  await client.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_02'])
  const cf = await waitForBeacon(client, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'client flying')
  console.log(`[local-multi/2] client lobby ${JSON.stringify(cf.lobby)} aircraft ${JSON.stringify(cf.aircraft)}`)
  const hs = await waitForBeacon(host, (b) => b.aircraft.filter((a) => a.alive).length >= 2, 30_000, 'host sees two aircraft')
  expect(hs.aircraft.filter((a) => a.alive).length).toBeGreaterThanOrEqual(2)
})

test('client: a canvas click and walking keys before the kiosk start must not block the join', async ({ browser }) => {
  test.setTimeout(300_000)
  const go = ([a, s]: string[]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => void }).__ysfxLobbyStart(a, s)
  const host = await pilot(browser)
  await host.goto(`http://localhost:5173/?ysfxnet=host:${ROOMS[2]}`)
  await waitForBeacon(host, (b) => b.role === 'host' && !!b.net && b.net.ready, 90_000, 'server ready')

  const client = await pilot(browser)
  await client.goto(`http://localhost:5173/?ysfxnet=client:${ROOMS[2]}`)
  await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready, 90_000, 'client connected')
  await waitForBeacon(client, (b) => !!b.lobby && b.lobby[0] > 10, 30_000, 'client lobby lists')
  // What the production harness does on the way to the kiosk.
  await client.mouse.click(640, 360)
  await client.waitForTimeout(500)
  await client.keyboard.down('w'); await client.waitForTimeout(400); await client.keyboard.up('w')
  await client.mouse.move(700, 380, { steps: 5 })
  await client.mouse.click(700, 380)
  await client.waitForTimeout(1000)
  await client.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_02'])
  const cf = await waitForBeacon(client, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'client flying after click+keys')
  console.log(`[local-multi/3] ${JSON.stringify(cf.net)} lobby ${JSON.stringify(cf.lobby)}`)
})
