/**
 * local-peer: trial "peer sky" -- two tabs, each running its engine alone,
 * linked by the relay room (?ysfxpeer=).  No WebRTC, no host, no client.
 * What is looked at: each sees the other's aircraft; how long from opening
 * the page to seeing it; and that closing the first tab leaves the second
 * flying with the first's aircraft gone.  The second test runs the current
 * way (host + client over WebRTC) through the same steps, for comparison.
 *
 * Needs the real GPU (the engine does not boot on SwiftShader):
 *   YSFX_ARGS="--enable-gpu --use-angle=vulkan --enable-features=Vulkan" \
 *     npx playwright test local-peer --config tests/playwright.config.ts --project=local-pc --trace off
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, waitForBeacon, watchBeacon, type Beacon } from './helpers'

type B = Beacon & { peer?: { open: boolean; sent: number; got: number; peers: number }; steps?: number; engine?: string | null }
const go = ([a, s]: string[]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => void }).__ysfxLobbyStart(a, s)
const other = (b: Beacon) => b.aircraft.find((a) => a.alive && !a.player)
const mine = (b: Beacon) => b.aircraft.find((a) => a.alive && a.player)

test('two engines, no server between them: see each other, survive the first one leaving', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `sky${Date.now() % 100000}`
  const ctxA = await browser.newContext(); const a = await ctxA.newPage(); await watchBeacon(a)
  a.on('console', (m) => { if (m.type() === 'error' || /ysf|abort|ABI/i.test(m.text())) console.log('[A]', m.text().slice(0, 300)) }); a.on('pageerror', (e) => console.log('[A pageerror]', String(e).slice(0, 400)))
  const ctxB = await browser.newContext(); const b = await ctxB.newPage(); await watchBeacon(b)
  try {
    await a.goto(`http://localhost:5173/?ysfxpeer=${sky}:A`)
    const ar = await waitForBeacon(a, (x) => !!x.net && x.net.ready, 90_000, 'A engine ready') as B
    console.log(`[local-peer] engine ${ar.engine}`)
    await waitForBeacon(a, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'A lobby')
    await a.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
    await waitForBeacon(a, (x) => !!x.net && x.net.state === NET_FLYING && x.net.playerAirId >= 0, 40_000, 'A flying')

    // B arrives late: A is already out.
    const t0 = Date.now()
    await b.goto(`http://localhost:5173/?ysfxpeer=${sky}:B`)
    await waitForBeacon(b, (x) => !!x.net && x.net.ready, 90_000, 'B engine ready')
    const tReady = Date.now()
    const bs = await waitForBeacon(b, (x) => !!other(x), 30_000, 'B sees A')
    const tSeen = Date.now()
    console.log(`[local-peer] B: page open -> engine ready ${tReady - t0} ms, -> sees A ${tSeen - t0} ms (after ready: ${tSeen - tReady} ms)`)
    console.log(`[local-peer] B sees ${JSON.stringify(other(bs))}; A is at ${JSON.stringify(mine((await waitForBeacon(a, (x) => !!mine(x), 5_000, 'A own')))?.pos)}`)

    await waitForBeacon(b, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'B lobby')
    await b.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_02'])
    await waitForBeacon(b, (x) => !!x.net && x.net.state === NET_FLYING && x.net.playerAirId >= 0, 40_000, 'B flying')
    const as = await waitForBeacon(a, (x) => !!other(x), 30_000, 'A sees B')
    const bOwn = mine(await waitForBeacon(b, (x) => !!mine(x), 5_000, 'B own'))!
    const seenB = other(as)!
    const d = Math.hypot(seenB.pos[0] - bOwn.pos[0], seenB.pos[1] - bOwn.pos[1], seenB.pos[2] - bOwn.pos[2])
    console.log(`[local-peer] A sees B ${JSON.stringify(seenB)}; B is at ${JSON.stringify(bOwn.pos)}; apart ${d.toFixed(2)} m`)
    expect(seenB.name).toMatch(/B$/)
    expect(d).toBeLessThan(5)

    if (process.env.YSFX_SHOTS) { await a.screenshot({ path: `${process.env.YSFX_SHOTS}/a-sees-b.png` }); await b.screenshot({ path: `${process.env.YSFX_SHOTS}/b-sees-a.png` }) }
    // B rolls down the runway at full throttle: does A's picture of B keep up?
    await b.mouse.click(640, 360)
    for (let i = 0; i < 20; i++) await b.keyboard.press('q')
    const start = bOwn.pos
    let worst = 0
    for (let i = 0; i < 8; i++) {
      await b.waitForTimeout(1000)
      const [o1, v, o2] = await Promise.all([waitForBeacon(b, (x) => !!mine(x), 5_000, 'B own'), waitForBeacon(a, (x) => !!other(x), 5_000, 'A view'), waitForBeacon(b, (x) => !!mine(x), 5_000, 'B own')])
      const own = mine(o2)!.pos, seen = other(v)!.pos
      const moved = Math.hypot(own[0] - start[0], own[2] - start[2])
      const gap = Math.hypot(seen[0] - own[0], seen[1] - own[1], seen[2] - own[2])
      const spd = Math.hypot(mine(o2)!.pos[0] - mine(o1)!.pos[0], mine(o2)!.pos[2] - mine(o1)!.pos[2]) / Math.max(0.001, (o2.t - o1.t) / 1000)
      worst = Math.max(worst, gap)
      console.log(`[local-peer] roll +${i + 1}s: B moved ${moved.toFixed(0)} m, alt ${own[1].toFixed(0)} m; A's picture is ${gap.toFixed(1)} m off (beacons ${(v.t - o2.t)} ms apart, B speed ~${spd.toFixed(0)} m/s)`)
    }
    console.log(`[local-peer] worst gap while moving ${worst.toFixed(1)} m`)

    // The first one leaves.  Nobody was the server, so nothing else should happen to B.
    const before = await waitForBeacon(b, () => true, 5_000, 'B before') as B
    await ctxA.close()
    const tClose = Date.now()
    const gone = await waitForBeacon(b, (x) => !other(x), 15_000, 'A gone from B') as B
    console.log(`[local-peer] A closed -> gone from B after ${Date.now() - tClose} ms; B peers ${JSON.stringify(gone.peer)}`)
    for (let i = 0; i < 5; i++) { await b.waitForTimeout(1000); const x = await waitForBeacon(b, () => true, 5_000, 'B poll') as B; console.log(`[local-peer] +${i + 1}s state ${x.net?.state} air ${JSON.stringify(x.aircraft.map((q) => [q.id, q.alive, q.player, q.name]))}`) }
    const after = await waitForBeacon(b, () => true, 5_000, 'B after') as B
    if (process.env.YSFX_SHOTS) await b.screenshot({ path: `${process.env.YSFX_SHOTS}/b-after-a-left.png` })
    console.log(`[local-peer] B after A left: steps ${before.steps} -> ${after.steps}, state ${after.net?.state}, own ${JSON.stringify(mine(after))}`)
    expect(after.steps! - before.steps!).toBeGreaterThan(100)
    expect(after.net?.state).toBe(NET_FLYING)
    expect(mine(after)).toBeTruthy()
  } finally {
    await ctxB.close(); await ctxA.close().catch(() => {})
  }
})

test('for comparison, the way it is now (host + client over WebRTC): join time, and the host leaving', async ({ browser }) => {
  test.setTimeout(300_000)
  const room = String(10000000 + (Date.now() % 89999999))
  const ctxH = await browser.newContext(); const h = await ctxH.newPage(); await watchBeacon(h)
  const ctxC = await browser.newContext(); const c = await ctxC.newPage(); await watchBeacon(c)
  try {
    await h.goto(`http://localhost:5173/?ysfxnet=host:${room}`)
    await waitForBeacon(h, (x) => x.role === 'host' && !!x.net && x.net.ready, 90_000, 'server ready')
    await waitForBeacon(h, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'host lobby')
    await h.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
    await waitForBeacon(h, (x) => !!x.net && x.net.state === NET_FLYING && x.net.playerAirId >= 0, 40_000, 'host flying')
    const t0 = Date.now()
    await c.goto(`http://localhost:5173/?ysfxnet=client:${room}`)
    await waitForBeacon(c, (x) => x.role === 'client' && !!x.net && x.net.ready, 90_000, 'client connected')
    const tReady = Date.now()
    await waitForBeacon(c, (x) => !!other(x), 30_000, 'client sees host')
    console.log(`[baseline] client: page open -> connected ${tReady - t0} ms, -> sees host ${Date.now() - t0} ms`)
    await waitForBeacon(c, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'client lobby')
    await c.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_02'])
    await waitForBeacon(c, (x) => !!x.net && x.net.state === NET_FLYING && x.net.playerAirId >= 0, 40_000, 'client flying')
    await ctxH.close()
    for (let i = 0; i < 8; i++) {
      await c.waitForTimeout(1000)
      const x = await waitForBeacon(c, () => true, 5_000, 'client poll') as B
      console.log(`[baseline] host closed +${i + 1}s: role ${x.role} ready ${x.net?.ready} state ${x.net?.state} own ${!!mine(x)} load ${JSON.stringify((x as unknown as { load?: unknown }).load)}`)
    }
  } finally {
    await ctxC.close(); await ctxH.close().catch(() => {})
  }
})
