/**
 * local-multi-field: host + client on a field other than the default.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

const FIELD = process.env.YSFX_MULTI_FIELD ?? 'NAHA_AIRPORT'
const open: Array<{ close: () => Promise<void> }> = []
test.afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())) })
async function pilot(browser: import('@playwright/test').Browser, tag: string) {
  const ctx = await browser.newContext()
  open.push(ctx)
  const page = await ctx.newPage()
  await watchBeacon(page)
  page.on('console', (m) => { const t = m.text(); if (/\[ysf|apron|WebRTC|room|closed|reject|field|LOGON|version/i.test(t)) console.log(`${new Date().toISOString().slice(11, 19)} ${tag} ${t.slice(0, 200)}`) })
  return page
}
type Hooks = { __ysfxSetField: (f: string) => string; __ysfxLobbyStart: (a: string, s: string) => string }

test('another field: a client who arrives later stands on the same apron and each sees the other fly', async ({ browser }) => {
  test.setTimeout(400_000)
  const room = '56789123'
  const host = await pilot(browser, 'H')
  await host.goto(`http://localhost:5173/?ysfxnet=host:${room}`)
  const first = await waitForBeacon(host, (b) => b.role === 'host' && !!b.net && b.net.ready && b.field.names.length > 0 && !!b.apron, 90_000, 'server ready')
  console.log(`[mf] fields ${first.field.names.join(' ')}`)
  const same = first.field.current === FIELD
  if (!same) await host.evaluate((f) => (window as unknown as Hooks).__ysfxSetField(f), FIELD)
  const hb = await waitForBeacon(host, (b) => b.field.current === FIELD && !!b.net && b.net.ready && b.load?.stage === 'ready' && !!b.apron && (same || Math.hypot(b.apron.spawn[0] - first.apron!.spawn[0], b.apron.spawn[2] - first.apron!.spawn[2]) > 1), 120_000, 'host on the other field')
  console.log(`[mf] host apron ${JSON.stringify(hb.apron)} items ${hb.kioskItems.map((i) => i.name).join(' ')}`)

  const client = await pilot(browser, 'C')
  await client.goto(`http://localhost:5173/?ysfxnet=client:${room}`)
  const cb = await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready && b.load?.stage === 'ready' && !!b.apron, 120_000, 'client connected, apron placed')
  console.log(`[mf] client apron ${JSON.stringify(cb.apron)} field ${JSON.stringify(cb.field.current)} lobby ${JSON.stringify(cb.lobby)}`)
  expect(Math.hypot(cb.apron!.spawn[0] - hb.apron!.spawn[0], cb.apron!.spawn[2] - hb.apron!.spawn[2])).toBeLessThan(1)

  const go = ([a, s]: string[]) => (window as unknown as Hooks).__ysfxLobbyStart(a, s)
  await host.evaluate(go, ['F-16C_FIGHTINGFALCON', hb.apron!.stp])
  const hf = await waitForBeacon(host, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'host flying')
  console.log(`[mf] host aircraft ${JSON.stringify(hf.aircraft)}`)
  const cs = await waitForBeacon(client, (b) => b.aircraft.some((a) => a.alive && !a.player && a.name !== ''), 30_000, 'client sees the host aircraft')
  console.log(`[mf] client sees ${JSON.stringify(cs.aircraft.filter((a) => a.name !== ''))}`)
  await client.bringToFront()
  await client.mouse.click(640, 360)
  await client.waitForTimeout(500)
  let mx = 640
  for (let k = 1; k <= 6; k++) {
    mx += 420
    await client.mouse.move(mx, 360, { steps: 20 })
    await client.waitForTimeout(700)
    await client.screenshot({ path: test.info().outputPath(`client-turn${k}.png`) })
  }
})

test('the host changes the field while a client is connected: both engines restart on the same room and meet again', async ({ browser }) => {
  test.setTimeout(400_000)
  const room = '67891234'
  const host = await pilot(browser, 'H')
  await host.goto(`http://localhost:5173/?ysfxnet=host:${room}`)
  const first = await waitForBeacon(host, (b) => b.role === 'host' && !!b.net && b.net.ready && b.field.names.length > 0 && !!b.apron, 90_000, 'server ready')
  const client = await pilot(browser, 'C')
  await client.goto(`http://localhost:5173/?ysfxnet=client:${room}`)
  await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready && b.load?.stage === 'ready', 120_000, 'client connected')
  await waitForBeacon(host, (b) => !!b.net && b.net.connected >= 1, 30_000, 'host counts the client')

  // Production restarts every engine at once when the field changes (the engine key carries the field).
  // The dev client is not told (no shared instance state): reload it at the same moment.
  const delay = Number(process.env.YSFX_MF_DELAY ?? 0)
  await host.evaluate((f) => (window as unknown as Hooks).__ysfxSetField(f), FIELD)
  if (delay) await client.waitForTimeout(delay)
  const t0 = Date.now()
  await client.reload()
  const hb = await waitForBeacon(host, (b) => b.field.current === FIELD && !!b.net && b.net.ready && b.load?.stage === 'ready' && !!b.apron && Math.hypot(b.apron.spawn[0] - first.apron!.spawn[0], b.apron.spawn[2] - first.apron!.spawn[2]) > 1, 120_000, 'host on the other field')
  const cb = await waitForBeacon(client, (b) => b.role === 'client' && !!b.net && b.net.ready && b.load?.stage === 'ready' && !!b.apron && b.t > t0, 200_000, 'client connected again')
  console.log(`[mf2] client back after ${((cb.t - t0) / 1000).toFixed(1)} s, tries ${JSON.stringify(cb.connect)} apron ${JSON.stringify(cb.apron)} host apron ${JSON.stringify(hb.apron)}`)
  expect(Math.hypot(cb.apron!.spawn[0] - hb.apron!.spawn[0], cb.apron!.spawn[2] - hb.apron!.spawn[2])).toBeLessThan(1)
  const go = ([a, s]: string[]) => (window as unknown as Hooks).__ysfxLobbyStart(a, s)
  await host.evaluate(go, ['F-16C_FIGHTINGFALCON', hb.apron!.stp])
  await waitForBeacon(host, (b) => !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 40_000, 'host flying')
  const cs = await waitForBeacon(client, (b) => b.aircraft.some((a) => a.alive && !a.player && a.name !== ''), 30_000, 'client sees the host aircraft')
  console.log(`[mf2] client sees ${JSON.stringify(cs.aircraft.filter((a) => a.name !== ''))}`)
})
