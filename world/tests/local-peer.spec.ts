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
  a.on('console', (m) => { if (/boot failed|abort/i.test(m.text())) console.log('[A]', m.text().slice(0, 300)) })
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

test('a gun hit crosses: the shooter reports it, the owner takes the damage and goes down, then flies again', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `gun${Date.now() % 100000}`
  type P = B & { peer?: { hitsOut: number; hitsIn: number } }
  const ctxT = await browser.newContext(); const t = await ctxT.newPage(); await watchBeacon(t)
  const ctxS = await browser.newContext(); const sh = await ctxS.newPage(); await watchBeacon(sh)
  try {
    // RW01_04 looks straight down the runway at RW01_01, about 400 m ahead.
    await t.goto(`http://localhost:5173/?ysfxpeer=${sky}:T`)
    await waitForBeacon(t, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'T lobby')
    await t.evaluate(go, [process.env.YSFX_TARGET || 'B747', 'RW01_01'])
    await waitForBeacon(t, (x) => !!mine(x), 40_000, 'T out')
    await sh.goto(`http://localhost:5173/?ysfxpeer=${sky}:S`)
    await waitForBeacon(sh, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'S lobby')
    await sh.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_04'])
    await waitForBeacon(sh, (x) => !!mine(x) && !!other(x) && x.seat !== null, 40_000, 'S out, seated, sees T')
    await sh.mouse.click(640, 360)
    await sh.waitForTimeout(500)
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/s-aims-at-t.png` })

    // On its gear the F-16's nose points 1.4 deg up, so its rounds climb 2.3 m per
    // 100 m (measured: 12 m up at 400 m, over anything parked there).  The target is
    // a 747 and the shooter rolls in: between 240 m and 60 m the rounds cross its fuselage.
    const dist = (x: Beacon) => { const m = mine(x)!, o = other(x)!; return Math.hypot(m.pos[0] - o.pos[0], m.pos[2] - o.pos[2]) }
    for (let i = 0; i < 20; i++) await sh.keyboard.press('q')
    await waitForBeacon(sh, (x) => !!mine(x) && !!other(x) && dist(x) < 240, 30_000, 'S within 240 m')
    await sh.keyboard.down('a') // throttle back while shooting
    await sh.keyboard.down('Shift')
    await sh.waitForTimeout(700)
    const dbg = await waitForBeacon(sh, () => true, 5_000, 'S dbg') as P
    console.log(`[gun] S ${mine(dbg) && other(dbg) ? dist(dbg).toFixed(0) : '?'} m from T after 0.7 s of trigger: fire ${JSON.stringify(dbg.fire)} hud ${JSON.stringify((dbg.hud ?? []).slice(0, 3))} peer ${JSON.stringify(dbg.peer)} sees ${JSON.stringify(dbg.aircraft.map((q) => [q.id, q.alive, q.player]))}`)
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/s-firing.png` })
    await waitForBeacon(t, (x) => ((x as P).peer?.hitsIn ?? 0) > 0, 20_000, 'a hit reaches T')
    const down = await waitForBeacon(t, (x) => !mine(x), 30_000, 'T goes down') as P
    const own = down.aircraft.find((q) => q.player), sCopy = other(down)
    console.log(`[gun] when T went down the shooter was ${own && sCopy ? Math.hypot(own.pos[0] - sCopy.pos[0], own.pos[2] - sCopy.pos[2]).toFixed(0) : '?'} m away (a ram needs it on top of T)`)
    const said = await waitForBeacon(t, (x) => (x.panel?.log ?? []).some((l) => /Shot down by/.test(l)), 10_000, 'T is told who shot it')
    console.log(`[gun] T's log: ${JSON.stringify((said.panel?.log ?? []).filter((l) => /Shot down/.test(l)))}`)
    await sh.keyboard.up('Shift'); await sh.keyboard.up('a')
    const sNow = await waitForBeacon(sh, () => true, 5_000, 'S now') as P
    console.log(`[gun] T went down: T took ${down.peer?.hitsIn} hits, S reported ${sNow.peer?.hitsOut}; T's log ${JSON.stringify((down.panel?.log ?? []).slice(-3))}`)
    if (process.env.YSFX_SHOTS) { await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/s-after-kill.png` }); await t.screenshot({ path: `${process.env.YSFX_SHOTS}/t-after-kill.png` }) }
    // On the shooter the copy is dead and stays dead (no ghost made again from late states).
    for (let i = 0; i < 4; i++) {
      await sh.waitForTimeout(1000)
      const x = await waitForBeacon(sh, () => true, 5_000, 'S poll')
      console.log(`[gun] +${i + 1}s S sees ${JSON.stringify(x.aircraft.map((q) => [q.id, q.alive, q.player, q.name]))}`)
      expect(other(x)).toBeFalsy()
    }
    console.log(`[gun] S itself: ${JSON.stringify(mine(await waitForBeacon(sh, () => true, 5_000, 'S own')) ?? 'gone (rolled into the wreck?)')}`)

    // T flies again: a new aircraft on S.
    await waitForBeacon(t, (x) => !!x.net && x.net.state !== NET_FLYING, 20_000, 'T back in standby')
    await t.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_02'])
    await waitForBeacon(t, (x) => !!mine(x), 40_000, 'T out again')
    const again = await waitForBeacon(sh, (x) => !!other(x), 20_000, 'S sees T again')
    console.log(`[gun] T flew again; S sees ${JSON.stringify(other(again))}`)
  } finally {
    await ctxS.close(); await ctxT.close()
  }
})

test('control: with the hit messages thrown away, what do the shooter\'s rounds do on the owner\'s side?', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `ctl${Date.now() % 100000}`
  type P = B & { peer?: { hitsOut: number; hitsIn: number; hitsDropped: number } }
  const ctxT = await browser.newContext(); const t = await ctxT.newPage(); await watchBeacon(t)
  const ctxS = await browser.newContext(); const sh = await ctxS.newPage(); await watchBeacon(sh)
  const dist = (x: Beacon) => { const m = x.aircraft.find((q) => q.player), o = x.aircraft.find((q) => !q.player); return m && o ? Math.hypot(m.pos[0] - o.pos[0], m.pos[2] - o.pos[2]) : NaN }
  try {
    await t.goto(`http://localhost:5173/?ysfxpeer=${sky}:T&ysfxnohit=1`)
    await waitForBeacon(t, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'T lobby')
    await t.evaluate(go, ['B747', 'RW01_01'])
    await waitForBeacon(t, (x) => !!mine(x), 40_000, 'T out')
    await sh.goto(`http://localhost:5173/?ysfxpeer=${sky}:S`)
    await waitForBeacon(sh, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'S lobby')
    await sh.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_04'])
    await waitForBeacon(sh, (x) => !!mine(x) && !!other(x) && x.seat !== null, 40_000, 'S out, seated, sees T')
    await sh.mouse.click(640, 360)
    // Roll to about 150 m and stop there (throttle to idle is slow: cut early), then shoot for a while.
    for (let i = 0; i < 20; i++) await sh.keyboard.press('q')
    await sh.waitForTimeout(2500)
    await sh.keyboard.down('a'); await sh.waitForTimeout(6000)
    await sh.keyboard.down('Shift')
    for (let i = 0; i < 8; i++) {
      await sh.waitForTimeout(700)
      const [xs, xt] = await Promise.all([waitForBeacon(sh, () => true, 5_000, 'S'), waitForBeacon(t, () => true, 5_000, 'T')]) as P[]
      console.log(`[control] +${((i + 1) * 0.7).toFixed(1)}s firing: on T: own ${mine(xt) ? 'alive' : 'DOWN'}, S ${dist(xt).toFixed(0)} m away, hits dropped ${xt.peer?.hitsDropped}; on S: T's copy ${other(xs) ? 'alive' : 'dead'}, reported ${xs.peer?.hitsOut}, S speed ${(xs.hud ?? [''])[0].slice(0, 16)}`)
    }
    await sh.keyboard.up('Shift'); await sh.keyboard.up('a')
    // The copy died on S, the owner did not: S should get the aircraft back.
    const back = await waitForBeacon(sh, (x) => !!other(x), 15_000, 'S sees T again').catch(() => null)
    console.log(`[control] after the shooting: S ${back ? 'has T back: ' + JSON.stringify(other(back)) : 'never got T back'}`)
  } finally {
    await ctxS.close(); await ctxT.close()
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
