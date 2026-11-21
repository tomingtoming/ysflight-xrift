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

type Out = { states: number; stateBytes: number; idents: number; identBytes: number; others: number; otherBytes: number }
type B = Beacon & { peer?: { open: boolean; sent: number; got: number; peers: number; out: Out }; steps?: number; engine?: string | null }
/** What a tab sent between two of its beacons: messages a second and bytes, by kind. */
const rate = (a: B, b: B) => {
  const s = (b.t - a.t) / 1000, x = a.peer!.out, y = b.peer!.out
  const st = y.states - x.states, id = y.idents - x.idents
  const ot = y.others - x.others
  return `${(st / s).toFixed(1)} states/s of ${st ? ((y.stateBytes - x.stateBytes) / st).toFixed(0) : '-'} bytes, ${(id / s).toFixed(1)} idents/s of ${id ? ((y.identBytes - x.identBytes) / id).toFixed(0) : '-'} bytes, ${(ot / s).toFixed(1)} other messages/s (alive, mission, events) = ${((st + id + ot) / s).toFixed(1)} messages/s, ${(((y.stateBytes - x.stateBytes) + (y.identBytes - x.identBytes) + (y.otherBytes - x.otherBytes)) / s).toFixed(0)} bytes/s`
}
const go = ([a, s, iff]: string[]) => (window as unknown as { __ysfxLobbyStart: (a: string, s: string, iff?: number) => void }).__ysfxLobbyStart(a, s, iff === undefined ? -1 : Number(iff))
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
    // Both stand still: how much does a parked aircraft send?
    const a0 = await waitForBeacon(a, () => true, 5_000, 'A') as B
    await a.waitForTimeout(5000)
    const a1 = await waitForBeacon(a, (x) => x.t > a0.t + 4000, 5_000, 'A') as B
    console.log(`[local-peer] parked, A sends ${rate(a0, a1)}; B still sees A: ${!!other(await waitForBeacon(b, () => true, 5_000, 'B'))}`)
    // B rolls down the runway at full throttle: does A's picture of B keep up?
    const b0 = await waitForBeacon(b, () => true, 5_000, 'B') as B
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
    console.log(`[local-peer] rolling, B sends ${rate(b0, await waitForBeacon(b, () => true, 5_000, 'B') as B)}`)

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

// In the air: the target starts at 10,000 ft, the shooter starts from the same
// place a few seconds later -- same aircraft, no input, so it flies the same path
// behind it with the target dead ahead.
type AirP = B & { peer?: { hitsOut: number; hitsIn: number; hitsDropped: number; launches: { out: number; in: number; shown: number } } }
const own = (x: Beacon) => x.aircraft.find((q) => q.player)
const copy = (x: Beacon) => x.aircraft.find((q) => !q.player)
const d3 = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
async function airPair(browser: import('@playwright/test').Browser, sky: string, gapMs: number, shooterIff = '-1', targetQuery = '') {
  const ctxT = await browser.newContext(); const t = await ctxT.newPage(); await watchBeacon(t)
  const ctxS = await browser.newContext(); const sh = await ctxS.newPage(); await watchBeacon(sh)
  const lag = process.env.YSFX_LAG ? `&ysfxlag=${process.env.YSFX_LAG}` : '' // e.g. 100:30 -- both tabs hold what they receive
  await t.goto(`http://localhost:5173/?ysfxpeer=${sky}:T${lag}${targetQuery}`)
  await sh.goto(`http://localhost:5173/?ysfxpeer=${sky}:S${lag}`)
  await waitForBeacon(t, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'T lobby')
  await waitForBeacon(sh, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'S lobby')
  await t.evaluate(go, ['F-16C_FIGHTINGFALCON', 'NORTH10000_01'])
  await waitForBeacon(t, (x) => !!mine(x), 40_000, 'T out')
  await t.waitForTimeout(gapMs)
  await sh.evaluate(go, ['F-16C_FIGHTINGFALCON', 'NORTH10000_01', shooterIff])
  await waitForBeacon(sh, (x) => !!mine(x) && !!other(x) && x.seat !== null, 40_000, 'S out, seated, sees T')
  await sh.mouse.click(640, 360)
  return { t, sh, close: async () => { await ctxS.close(); await ctxT.close() } }
}
/** Positions of one aircraft as a page's beacons report them (10 a second), for `ms`. */
function series(page: import('@playwright/test').Page, player: boolean, ms: number): Promise<Array<{ t: number; pos: number[] }>> {
  return page.evaluate(([pl, dur]) => new Promise<Array<{ t: number; pos: number[] }>>((done) => {
    const out: Array<{ t: number; pos: number[] }> = []
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail as { t: number; aircraft: Array<{ alive: boolean; player: boolean; pos: number[] }> }
      const a = d.aircraft.find((q) => q.alive && q.player === pl)
      if (a) out.push({ t: d.t, pos: a.pos })
    }
    window.addEventListener('ysfx-state', on)
    setTimeout(() => { window.removeEventListener('ysfx-state', on); done(out) }, dur as number)
  }), [player, ms] as const)
}
/**
 * How far behind the truth the shooter's picture of the target is (as time),
 * and how evenly the picture moves: both pages' beacons over three seconds.
 */
async function pictureLag(t: import('@playwright/test').Page, sh: import('@playwright/test').Page, tag: string) {
  const [truth, seen] = await Promise.all([series(t, true, 3000), series(sh, false, 3000)])
  const lags: number[] = []
  let spd = 0
  for (const sm of seen) {
    const k = truth.findIndex((q) => q.t >= sm.t)
    if (k < 1) continue
    const a = truth[k - 1], b = truth[k]
    const f = (sm.t - a.t) / (b.t - a.t)
    const at = [0, 1, 2].map((n) => a.pos[n] + (b.pos[n] - a.pos[n]) * f) // where T really was when S looked
    spd = d3(a.pos, b.pos) / ((b.t - a.t) / 1000)
    const dir = [0, 1, 2].map((n) => (b.pos[n] - a.pos[n]) / d3(a.pos, b.pos))
    lags.push([0, 1, 2].reduce((acc, n) => acc + (at[n] - sm.pos[n]) * dir[n], 0) / spd * 1000)
  }
  const v: number[] = []
  for (let n = 1; n < seen.length; n++) v.push(d3(seen[n].pos, seen[n - 1].pos) / ((seen[n].t - seen[n - 1].t) / 1000))
  const tv: number[] = []
  for (let n = 1; n < truth.length; n++) tv.push(d3(truth[n].pos, truth[n - 1].pos) / ((truth[n].t - truth[n - 1].t) / 1000))
  const stat = (x: number[]) => { const m = x.reduce((p, q) => p + q, 0) / x.length; return `mean ${m.toFixed(0)} sd ${Math.sqrt(x.reduce((p, q) => p + (q - m) ** 2, 0) / x.length).toFixed(1)} min ${Math.min(...x).toFixed(0)} max ${Math.max(...x).toFixed(0)}` }
  lags.sort((x, y) => x - y)
  console.log(`[${tag}] T flies ${spd.toFixed(0)} m/s; S's picture of T is behind by (ms, ${lags.length} samples) median ${lags[lags.length >> 1]?.toFixed(0)}, min ${lags[0]?.toFixed(0)}, max ${lags[lags.length - 1]?.toFixed(0)}`)
  console.log(`[${tag}] speed between beacons (m/s): the picture on S ${stat(v)} | the real one on T ${stat(tv)}`)
}
/** After the target is hit for good: what its owner sees of it and what the shooter sees of it, side by side. */
async function aftermath(t: import('@playwright/test').Page, sh: import('@playwright/test').Page, tag: string) {
  for (let i = 0; i < 10; i++) {
    await sh.waitForTimeout(700)
    const [xt, xs] = await Promise.all([waitForBeacon(t, () => true, 5_000, 'T'), waitForBeacon(sh, () => true, 5_000, 'S')])
    const o = own(xt), c = copy(xs)
    console.log(`[${tag}] +${((i + 1) * 0.7).toFixed(1)}s owner: ${o ? `${o.alive ? 'falling' : 'gone'} alt ${o.pos[1].toFixed(0)}` : 'no aircraft'} | shooter's picture: ${c ? `${c.alive ? 'falling' : 'gone'} alt ${c.pos[1].toFixed(0)}` : 'no aircraft'}${o && c ? ` | ${d3(o.pos, c.pos).toFixed(0)} m apart` : ''}`)
  }
}

test('in the air: guns from behind', async ({ browser }) => {
  test.setTimeout(300_000)
  const { t, sh, close } = await airPair(browser, `airg${Date.now() % 100000}`, 1500)
  try {
    const first = await waitForBeacon(sh, (x) => !!mine(x) && !!other(x), 5_000, 'S') as AirP
    console.log(`[air-gun] S starts ${d3(mine(first)!.pos, other(first)!.pos).toFixed(0)} m behind T; S hud ${JSON.stringify((first.hud ?? []).slice(0, 3))}`)
    await pictureLag(t, sh, 'air-gun')
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/air-gun-aim.png` })
    // Both glide nose-down, so the target ahead sits below the gun line: shoot
    // while easing the nose down through it and back up, a few times.
    await sh.keyboard.down('Shift')
    // Enough for this test: rounds that hit on the shooter's side arrive at the owner.  (Two rounds do not bring an F-16 down.)
    const isDown = (x: Beacon) => ((x as AirP).peer?.hitsIn ?? 0) > 0
    let down: AirP | null = null
    for (let pass = 0; pass < 6 && !down; pass++) {
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) {
        await sh.keyboard.press(key)
        down = await waitForBeacon(t, isDown, 700, 'T hit').catch(() => null) as AirP | null
        const x = await waitForBeacon(sh, () => true, 5_000, 'S') as AirP
        if (pass === 0) console.log(`[air-gun] ${key}: S pitch stick ${x.ctl?.[2]?.toFixed(2)}, reported ${x.peer?.hitsOut}, T ${other(x) ? d3(mine(x)!.pos, other(x)!.pos).toFixed(0) + ' m ahead, ' + (other(x)!.pos[1] - mine(x)!.pos[1]).toFixed(0) + ' m above' : 'gone'}`)
        if (down) break
      }
    }
    await sh.keyboard.up('Shift')
    const xs = await waitForBeacon(sh, () => true, 5_000, 'S') as AirP, xt = await waitForBeacon(t, () => true, 5_000, 'T') as AirP
    console.log(`[air-gun] ${down ? 'hits reached T' : 'no hit reached T'} (T ${mine(xt) ? 'still flying' : 'no longer flying'}, shot down by the gun: ${(xt.panel?.log ?? []).some((l) => /Shot down by/.test(l))}): S reported ${xs.peer?.hitsOut}, T took ${xt.peer?.hitsIn}; S gun ${JSON.stringify((xs.hud ?? []).slice(2, 3))}`)
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/air-gun-after.png` })
    expect(down).toBeTruthy()
    expect(xt.peer?.hitsIn).toBe(xs.peer?.hitsOut)
  } finally { await close() }
})

test('in the air: a missile from behind', async ({ browser }) => {
  test.setTimeout(300_000)
  // The shooter flies for another side than the target's (the default one): a heat seeker does not lock
  // on an aircraft of its own side, and a copy now carries its owner's side (YSFX_SHOOTER_IFF=-1 shows that).
  const { t, sh, close } = await airPair(browser, `airm${Date.now() % 100000}`, 5000, process.env.YSFX_SHOOTER_IFF ?? '0')
  try {
    const first = await waitForBeacon(sh, (x) => !!mine(x) && !!other(x), 5_000, 'S') as AirP
    console.log(`[air-aam] S starts ${d3(mine(first)!.pos, other(first)!.pos).toFixed(0)} m behind T`)
    await pictureLag(t, sh, 'air-aam')
    // Key 2 cycles the selected weapon; the HUD's third line names it.
    for (let i = 0; i < 14; i++) {
      const x = await waitForBeacon(sh, (q) => (q.hud ?? []).length > 2, 5_000, 'S hud')
      const was = (x.hud ?? [])[2]
      if (/AIM9 /.test(was)) break
      await sh.keyboard.down('2'); await sh.waitForTimeout(80); await sh.keyboard.up('2')
      await waitForBeacon(sh, (q) => (q.hud ?? [])[2] !== was, 1_500, 'weapon changes').catch(() => null)
    }
    const sel = await waitForBeacon(sh, () => true, 5_000, 'S')
    console.log(`[air-aam] S selected ${JSON.stringify((sel.hud ?? []).slice(2, 3))}`)
    await sh.waitForTimeout(1500) // let the seeker see the target
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/air-aam-aim.png` })
    const t0 = Date.now()
    await sh.keyboard.down('Shift'); await sh.waitForTimeout(250); await sh.keyboard.up('Shift')
    if (process.env.YSFX_SHOTS) { await sh.waitForTimeout(600); await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/air-aam-s-flying.png` }); await t.screenshot({ path: `${process.env.YSFX_SHOTS}/air-aam-t-view.png` }) }
    const down = await waitForBeacon(t, (x) => (x.panel?.log ?? []).some((l) => /Shot down by/.test(l)) || ((x as AirP).peer?.hitsIn ?? 0) > 0, 25_000, 'T hit').catch(() => null) as AirP | null
    const xs = await waitForBeacon(sh, () => true, 5_000, 'S') as AirP, xt = await waitForBeacon(t, () => true, 5_000, 'T') as AirP
    console.log(`[air-aam] ${down ? `T hit ${Date.now() - t0} ms after launch` : 'T NOT hit in 25 s'}: S reported ${xs.peer?.hitsOut}, T took ${xt.peer?.hitsIn}; T log ${JSON.stringify((xt.panel?.log ?? []).filter((l) => /Shot down/.test(l)))}; S weapon now ${JSON.stringify((xs.hud ?? []).slice(2, 3))}`)
    console.log(`[air-aam] the launch: S told ${xs.peer?.launches.out}, T heard ${xt.peer?.launches.in} and its engine replayed ${xt.peer?.launches.shown}`)
    await t.waitForTimeout(1500)
    console.log(`[air-aam] the score after it: on T ${JSON.stringify(((await waitForBeacon(t, () => true, 5_000, 'T')) as unknown as { peer: { sky: { scores: unknown } } }).peer.sky.scores)} | on S ${JSON.stringify(((await waitForBeacon(sh, () => true, 5_000, 'S')) as unknown as { peer: { sky: { scores: unknown } } }).peer.sky.scores)}`)
    if (down) await aftermath(t, sh, 'air-aam')
    expect(down).toBeTruthy()
    expect(xt.peer?.launches.shown).toBeGreaterThan(0)
  } finally { await close() }
})

test('control: the missile the target\'s browser replays is scenery -- with the hit messages thrown away the target flies on', async ({ browser }) => {
  test.setTimeout(300_000)
  const { t, sh, close } = await airPair(browser, `airc${Date.now() % 100000}`, 5000, '0', '&ysfxnohit=1')
  try {
    await selectWeapon(sh, /AIM9 /)
    await sh.waitForTimeout(1500)
    await sh.keyboard.down('Shift'); await sh.waitForTimeout(250); await sh.keyboard.up('Shift')
    const hit = await waitForBeacon(t, (x) => ((x as AirP).peer?.hitsDropped ?? 0) > 0, 25_000, 'the hit message reaches T (and is thrown away)') as AirP
    await t.waitForTimeout(6000) // long enough for the replayed missile to arrive too
    const xt = await waitForBeacon(t, () => true, 5_000, 'T') as AirP, xs = await waitForBeacon(sh, () => true, 5_000, 'S') as AirP
    console.log(`[air-control] S told ${xs.peer?.launches.out} launch and ${xs.peer?.hitsOut} hit; T replayed ${xt.peer?.launches.shown} launch, threw away ${xt.peer?.hitsDropped} hit (first at ${hit.t}); T's own aircraft is ${mine(xt) ? 'still flying, alt ' + mine(xt)!.pos[1].toFixed(0) : 'DOWN'}`)
    expect(xt.peer?.launches.shown).toBeGreaterThan(0)
    expect(mine(xt)).toBeTruthy()
  } finally { await close() }
})

type G = B & { peer?: { owned: number; hitsOut: number; hitsIn: number; ground: { n: number; dead: number; damage: number; hitsOut: number; hitsIn: number } } }
const gnd = (x: Beacon) => (x as G).peer!.ground
async function selectWeapon(page: import('@playwright/test').Page, re: RegExp) {
  for (let i = 0; i < 14; i++) {
    const x = await waitForBeacon(page, (q) => (q.hud ?? []).length > 2, 5_000, 'hud')
    const was = (x.hud ?? [])[2]
    if (re.test(was)) return
    await page.keyboard.down('2'); await page.waitForTimeout(80); await page.keyboard.up('2')
    await waitForBeacon(page, (q) => (q.hud ?? [])[2] !== was, 1_500, 'weapon changes').catch(() => null)
  }
}

test('ground objects: one destroyed by a missile is destroyed for everyone, for a newcomer too, and revived for all', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `gnd${Date.now() % 100000}`
  const open = async (who: string) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await watchBeacon(page); await page.goto(`http://localhost:5173/?ysfxpeer=${sky}:${who}`); await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, `${who} lobby`); return { ctx, page } }
  const S = await open('S'), O = await open('O') // O only watches: it has no aircraft out
  let L: Awaited<ReturnType<typeof open>> | null = null
  try {
    await S.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_04'])
    await waitForBeacon(S.page, (x) => !!mine(x) && x.seat !== null, 40_000, 'S out')
    await S.page.mouse.click(640, 360)
    await selectWeapon(S.page, /AGM65 /)
    await S.page.waitForTimeout(1500)
    for (let i = 0; i < 3; i++) { await S.page.keyboard.down('Shift'); await S.page.waitForTimeout(250); await S.page.keyboard.up('Shift'); await S.page.waitForTimeout(1500) }
    const sh = await waitForBeacon(S.page, (x) => gnd(x).dead > 0, 40_000, 'S destroys a ground object')
    const ob = await waitForBeacon(O.page, (x) => gnd(x).dead === gnd(sh).dead && gnd(x).damage === gnd(sh).damage, 10_000, 'O has the same')
    console.log(`[ground] shooter ${JSON.stringify(gnd(sh))} | watcher ${JSON.stringify(gnd(ob))}`)
    console.log(`[ground] the missiles: shooter told ${(sh as unknown as AirP).peer!.launches.out} launches, the watcher's engine replayed ${(ob as unknown as AirP).peer!.launches.shown}`)
    expect(gnd(ob).hitsIn).toBe(gnd(sh).hitsOut)

    L = await open('L') // arrives after the fact
    const late = await waitForBeacon(L.page, (x) => gnd(x).dead === gnd(sh).dead && gnd(x).damage === gnd(sh).damage, 15_000, 'the newcomer has the same')
    console.log(`[ground] newcomer ${JSON.stringify(gnd(late))} (it received no hit, only the totals)`)
    expect(gnd(late).hitsIn).toBe(0)

    // The watcher revives the ground objects (the session panel's command): everyone's come back.
    await O.page.evaluate(() => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(15))
    for (const [who, pg] of [['watcher', O.page], ['shooter', S.page], ['newcomer', L.page]] as const) {
      const x = await waitForBeacon(pg, (q) => gnd(q).dead === 0 && gnd(q).damage === 0, 15_000, `${who} revived`)
      console.log(`[ground] after the revival, ${who} ${JSON.stringify(gnd(x))}`)
    }
  } finally { await S.ctx.close(); await O.ctx.close(); await L?.ctx.close() }
})

test('a mission\'s aircraft: made by one browser, seen and fought by the other', async ({ browser }) => {
  test.setTimeout(400_000)
  const sky = `mis${Date.now() % 100000}`
  const open = async (who: string) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await watchBeacon(page); await page.goto(`http://localhost:5173/?ysfxpeer=${sky}:${who}`); await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, `${who} lobby`); return { ctx, page } }
  const M = await open('M'), V = await open('V')
  const unnamed = (x: Beacon) => x.aircraft.filter((q) => q.alive && !q.player && q.name === '')
  try {
    await M.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
    await waitForBeacon(M.page, (x) => !!mine(x), 40_000, 'M out')
    // V stays parked on the runway, nose to the north: the mission's aircraft come from there, to attack.
    await V.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_04'])
    await waitForBeacon(V.page, (x) => !!mine(x) && x.seat !== null, 40_000, 'V out')
    await V.page.mouse.click(640, 360)
    console.log(`[mission] before: M sees unnamed ${unnamed(await waitForBeacon(M.page, () => true, 5_000, 'M')).length}, V sees ${unnamed(await waitForBeacon(V.page, () => true, 5_000, 'V')).length}`)
    await M.page.evaluate(() => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(11)) // endurance (jets)
    const mm = await waitForBeacon(M.page, (x) => unnamed(x).length > 0, 30_000, 'the mission makes an aircraft on M') as G
    const vv = await waitForBeacon(V.page, (x) => unnamed(x).length === unnamed(mm).length, 15_000, 'V sees it')
    const a = unnamed(mm)[0], c = unnamed(vv)[0]
    console.log(`[mission] M owns ${mm.peer?.owned} aircraft; its mission's is at ${JSON.stringify(a.pos.map(Math.round))}; V sees one at ${JSON.stringify(c.pos.map(Math.round))} (${d3(a.pos, c.pos).toFixed(0)} m apart, beacons ${vv.t - mm.t} ms apart)`)
    await selectWeapon(V.page, /AIM9 /)
    // Up to 200 s: V shoots a missile when the mission's aircraft is ahead, low and within 5 km; who hits whom is whatever happens.
    let shots = 0, seenFight = 0
    for (let i = 0; i < 80; i++) {
      await V.page.waitForTimeout(2500)
      const [xm, xv] = await Promise.all([waitForBeacon(M.page, () => true, 5_000, 'M'), waitForBeacon(V.page, () => true, 5_000, 'V')]) as G[]
      const me = mine(xv), foe = unnamed(xv)[0]
      const far = me && foe ? d3(me.pos, foe.pos) : NaN
      const ahead = me && foe ? (me.pos[2] - foe.pos[2]) / far : 0, up = me && foe ? (foe.pos[1] - me.pos[1]) / far : 1
      if (me && foe && far < 5000 && ahead > 0.9 && up < 0.3 && shots < 6) { await V.page.keyboard.down('Shift'); await V.page.waitForTimeout(250); await V.page.keyboard.up('Shift'); shots++ }
      const fight = (xv.peer?.hitsOut ?? 0) + (xm.peer?.hitsOut ?? 0)
      if (i % 8 === 7 || !me || !foe || fight !== seenFight) console.log(`[mission] +${((i + 1) * 2.5).toFixed(0)}s: V ${me ? 'flying' : 'DOWN'}, mission aircraft on V ${unnamed(xv).length} / on M ${unnamed(xm).length}, ${isNaN(far) ? '-' : far.toFixed(0) + ' m'} from V${foe ? ` at alt ${foe.pos[1].toFixed(0)}` : ''}; V shot ${shots}, V's hits on it: sent ${xv.peer?.hitsOut} -> M took ${xm.peer?.hitsIn}; its hits on V: M sent ${xm.peer?.hitsOut} -> V took ${xv.peer?.hitsIn}`)
      seenFight = fight
      if (!me || !foe) break
    }
    if (process.env.YSFX_SHOTS) await V.page.screenshot({ path: `${process.env.YSFX_SHOTS}/mission-v.png` })
    // The other way round, with the hits injected (a dev hook sends them as V's): the owner's engine must bring its mission aircraft down.
    const before = await waitForBeacon(M.page, (x) => unnamed(x).length > 0, 30_000, 'M has a mission aircraft') as G
    const target = unnamed(before)[0]
    await waitForBeacon(V.page, (x) => unnamed(x).length >= unnamed(before).length, 10_000, 'V sees it')
    let sentAs = ''
    for (let i = 0; i < 30; i++) {
      // The owner's search key of the aircraft is what names it between browsers: the id its owner's beacon shows.
      sentAs = await V.page.evaluate((g) => (window as unknown as { __ysfxPeerTestHit: (p: number, gen?: number) => string }).__ysfxPeerTestHit(20, g), target.id)
      await V.page.waitForTimeout(150)
      const xm = await waitForBeacon(M.page, () => true, 5_000, 'M') as G
      if (!xm.aircraft.some((q) => q.id === target.id && q.alive)) break
    }
    const after = await waitForBeacon(M.page, (x) => !x.aircraft.some((q) => q.id === target.id && q.alive), 15_000, 'the mission aircraft goes down on its owner') as G
    console.log(`[mission] injected hits on ${sentAs} (M's aircraft ${target.id}): M took ${after.peer!.hitsIn - before.peer!.hitsIn} and it is ${after.aircraft.some((q) => q.id === target.id && q.alive) ? 'still alive' : 'down'}`)
    await M.page.evaluate(() => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(14)) // terminate
    await waitForBeacon(M.page, (x) => unnamed(x).length === 0, 20_000, 'the mission ends on M')
    await waitForBeacon(V.page, (x) => unnamed(x).length === 0, 10_000, 'its aircraft are gone on V')
    console.log('[mission] terminated: no mission aircraft left on either')
  } finally { await M.ctx.close(); await V.ctx.close() }
})

type M2 = G & { peer?: { owned: number; ownedGround: number; ownedDropped: number; groundCopies: number; peers: number; groundPos: { owned: number[][]; copies: number[][] } } }
test('close air support: the mission\'s tanks and aircraft exist on the other browser, and what they destroy is destroyed there', async ({ browser }) => {
  test.setTimeout(500_000)
  const sky = `cas${Date.now() % 100000}`
  const open = async (who: string) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await watchBeacon(page); await page.goto(`http://localhost:5173/?ysfxpeer=${sky}:${who}`); await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, `${who} lobby`); return { ctx, page } }
  const M = await open('M'), V = await open('V')
  try {
    await M.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
    await waitForBeacon(M.page, (x) => !!mine(x), 40_000, 'M out')
    await M.page.evaluate(() => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(13)) // close air support
    const first = await waitForBeacon(M.page, (x) => ((x as M2).peer?.ownedGround ?? 0) > 0, 60_000, 'the mission makes ground units') as M2
    console.log(`[cas] M owns ${first.peer!.owned} things, ${first.peer!.ownedGround} of them ground units (not published for lack of room: ${first.peer!.ownedDropped})`)
    for (let i = 0; i < 4; i++) {
      await M.page.waitForTimeout(10_000)
      const [xm, xv] = await Promise.all([waitForBeacon(M.page, () => true, 5_000, 'M'), waitForBeacon(V.page, () => true, 5_000, 'V')]) as M2[]
      console.log(`[cas] +${(i + 1) * 10}s: M owns ${xm.peer!.owned} (${xm.peer!.ownedGround} ground, dropped ${xm.peer!.ownedDropped}) | V has copies: ${xv.peer!.peers} aircraft, ${xv.peer!.groundCopies} ground | field ground on M ${JSON.stringify([gnd(xm).n, gnd(xm).dead, gnd(xm).damage])} on V ${JSON.stringify([gnd(xv).n, gnd(xv).dead, gnd(xv).damage])} (M sent ${gnd(xm).hitsOut} ground hits, V took ${gnd(xv).hitsIn})`)
      // Each ground unit M owns against the nearest copy on V.
      const apart = xm.peer!.groundPos.owned.map((o) => Math.min(...xv.peer!.groundPos.copies.map((c) => d3(o, c)), Infinity))
      console.log(`[cas]      M's ground units ${JSON.stringify(xm.peer!.groundPos.owned.map((o) => o.map(Math.round)))}; nearest copy on V (m): ${JSON.stringify(apart.map((a) => +a.toFixed(1)))}`)
      if (i === 3) { expect(xv.peer!.groundCopies).toBe(xm.peer!.ownedGround); expect(Math.max(...apart)).toBeLessThan(15) }
    }
    const xm = await waitForBeacon(M.page, () => true, 5_000, 'M') as M2
    const xv = await waitForBeacon(V.page, (x) => (x as M2).peer!.groundCopies === xm.peer!.ownedGround || true, 5_000, 'V') as M2
    expect(gnd(xv).n).toBe(gnd(xm).n) // the copies must not be counted as the field's own
    // A hit on a copy of a ground unit goes to its owner (injected: a dev hook sends it as V's).
    for (let i = 0; i < 40; i++) {
      await V.page.evaluate(() => (window as unknown as { __ysfxPeerTestHit: (p: number, gen?: number, cls?: number) => string }).__ysfxPeerTestHit(30, undefined, 1))
      await V.page.waitForTimeout(150)
      if ((await waitForBeacon(M.page, () => true, 5_000, 'M') as M2).peer!.ownedGround < xm.peer!.ownedGround) break
    }
    const m2 = await waitForBeacon(M.page, (x) => (x as M2).peer!.ownedGround < xm.peer!.ownedGround, 15_000, 'a ground unit goes down on its owner') as M2
    const v2 = await waitForBeacon(V.page, (x) => (x as M2).peer!.groundCopies === m2.peer!.ownedGround, 15_000, 'and on V') as M2
    console.log(`[cas] injected hits on a ground unit: M owns ${xm.peer!.ownedGround} -> ${m2.peer!.ownedGround} ground units, V has ${v2.peer!.groundCopies} copies; score on V ${JSON.stringify((v2 as unknown as { peer: { sky: { scores: unknown } } }).peer.sky.scores)}`)
    await M.page.evaluate(() => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(14))
    const end = await waitForBeacon(V.page, (x) => (x as M2).peer!.groundCopies === 0, 20_000, 'the copies go with the mission') as M2
    console.log(`[cas] terminated: V has ${end.peer!.groundCopies} ground copies, ${end.peer!.peers} aircraft copies; field ground on V ${JSON.stringify([gnd(end).n, gnd(end).dead, gnd(end).damage])}`)
  } finally { await M.ctx.close(); await V.ctx.close() }
})

test('the field: one tab changes it, every tab moves there (a newcomer too), and they still see each other', async ({ browser }) => {
  test.setTimeout(400_000)
  const sky = `fld${Date.now() % 100000}`
  const open = async (who: string) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await watchBeacon(page); await page.goto(`http://localhost:5173/?ysfxpeer=${sky}:${who}`); return { ctx, page } }
  const ready = (page: import('@playwright/test').Page, field: string, who: string) => waitForBeacon(page, (x) => x.field.current === field && !!x.net && x.net.ready && !!x.lobby && x.lobby[0] > 10 && x.load?.stage === 'ready', 120_000, `${who} ready on ${field}`)
  const A = await open('A'), Bt = await open('B')
  let C: Awaited<ReturnType<typeof open>> | null = null
  try {
    const a0 = await ready(A.page, 'ATSUGI_AIRBASE', 'A'); await ready(Bt.page, 'ATSUGI_AIRBASE', 'B')
    const other2 = a0.field.names.find((n) => /NAHA/.test(n)) ?? a0.field.names.find((n) => n !== 'ATSUGI_AIRBASE')!
    const t0 = Date.now()
    await Bt.page.evaluate((f) => (window as unknown as { __ysfxSetField: (f: string) => string }).__ysfxSetField(f), other2) // B changes it, not A
    await ready(Bt.page, other2, 'B'); const tB = Date.now() - t0
    const a1 = await ready(A.page, other2, 'A')
    console.log(`[field] B chose ${other2}: B there after ${tB} ms, A after ${Date.now() - t0} ms; A's field has ${(a1 as G).peer?.ground.n} ground objects (Atsugi: ${(a0 as G).peer?.ground.n})`)
    C = await open('C')
    await ready(C.page, other2, 'C (arrived later)')
    console.log(`[field] a newcomer lands on ${other2} too`)
    // After the engines restarted on the new field: do the tabs still see each other?
    const stps = await A.page.evaluate(() => { const m = (window as unknown as { __ysfx: { _FsVrLobbyStpCount: () => number; _FsVrLobbyStpName: (i: number) => number; UTF8ToString: (p: number) => string } }).__ysfx; return Array.from({ length: Math.min(4, m._FsVrLobbyStpCount()) }, (_, i) => m.UTF8ToString(m._FsVrLobbyStpName(i))) })
    await A.page.evaluate(go, ['F-16C_FIGHTINGFALCON', stps[0]])
    await waitForBeacon(A.page, (x) => !!mine(x), 40_000, 'A out')
    await Bt.page.evaluate(go, ['F-16C_FIGHTINGFALCON', stps[1]])
    await waitForBeacon(Bt.page, (x) => !!mine(x), 40_000, 'B out')
    const seen = await Promise.all([A.page, Bt.page, C.page].map((pg, i) => waitForBeacon(pg, (x) => x.aircraft.filter((q) => q.alive && !q.player).length === (i === 2 ? 2 : 1), 20_000, `tab ${i} sees the others`)))
    console.log(`[field] on ${other2} (${stps[0]}, ${stps[1]}): A sees ${seen[0].aircraft.filter((q) => q.alive && !q.player).length} other, B sees ${seen[1].aircraft.filter((q) => q.alive && !q.player).length}, C (no aircraft) sees ${seen[2].aircraft.filter((q) => q.alive && !q.player).length}`)
  } finally { await A.ctx.close(); await Bt.ctx.close(); await C?.ctx.close() }
})

type Sky = { mission: null | { cmd: number; seconds: number; owner: number }; scores: Record<string, { kills: number; losses: number }>; roster: number[]; yielded: number; adopted: number; kills: number }
type S2 = M2 & { peer?: { self: number; sky: Sky } }
const sky2 = (x: Beacon) => (x as S2).peer!.sky
const cmd = (page: import('@playwright/test').Page, c: number) => page.evaluate((k) => (window as unknown as { __ysfxNetCommand: (c: number) => string }).__ysfxNetCommand(k), c)
const openTab = async (browser: import('@playwright/test').Browser, sky: string, who: string) => { const ctx = await browser.newContext(); const page = await ctx.newPage(); await watchBeacon(page)
  // An engine that dies shows only here: the page goes on answering with what it last had.
  page.on('pageerror', (e) => console.log(`[${who}] page error: ${String(e).slice(0, 300)}`)); page.on('console', (m) => { if (/abort|boot failed|RuntimeError|unreachable|out of bounds|Sanitizer|SUMMARY|\s#[0-5] 0x/i.test(m.text())) console.log(`[${who}] ${m.text().slice(0, 300)}`) })
  await page.goto(`http://localhost:5173/?ysfxpeer=${sky}:${who}`); await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, `${who} lobby`); return { ctx, page } }

test('a mission is the sky\'s: the others see which and how long; two at once leave one; its browser leaving hands it over', async ({ browser }) => {
  test.setTimeout(500_000)
  const sky = `ref${Date.now() % 100000}`
  const A = await openTab(browser, sky, 'A'), Bt = await openTab(browser, sky, 'B'), C = await openTab(browser, sky, 'C')
  try {
    const ids = await Promise.all([A, Bt, C].map(async (t) => ((await waitForBeacon(t.page, (x) => ((x as S2).peer?.self ?? 0) > 0 && sky2(x).roster.length === 2, 20_000, 'sees the two others')) as S2).peer!.self))
    console.log(`[referee] the three tabs are senders ${JSON.stringify(ids)}; each sees the two others`)
    // 1. B starts a mission: A and C show it, with B as its browser, and the time runs.
    await cmd(Bt.page, 11)
    const b1 = await waitForBeacon(Bt.page, (x) => sky2(x).mission?.cmd === 11 && sky2(x).mission?.owner === 0, 15_000, 'B runs it')
    const a1 = await waitForBeacon(A.page, (x) => sky2(x).mission?.cmd === 11 && sky2(x).mission?.owner === ids[1], 15_000, 'A shows B\'s')
    await A.page.waitForTimeout(5000)
    const a2 = await waitForBeacon(A.page, (x) => (sky2(x).mission?.seconds ?? 9999) < sky2(a1).mission!.seconds - 3, 10_000, 'the time runs on A')
    console.log(`[referee] B started endurance: B shows ${JSON.stringify(sky2(b1).mission)}, A shows ${JSON.stringify(sky2(a1).mission)} then ${JSON.stringify(sky2(a2).mission)}; panel line on A: ${JSON.stringify((a2.panel?.log ?? []).slice(-1))}`)
    // 2. A (a lower number) starts another: B's ends, everyone shows A's.
    await cmd(A.page, 13)
    const all = await Promise.all([A, Bt, C].map((t, i) => waitForBeacon(t.page, (x) => sky2(x).mission?.cmd === 13 && sky2(x).mission?.owner === (i === 0 ? 0 : ids[0]), 20_000, `tab ${i} shows A's mission`)))
    const bEngine = await waitForBeacon(Bt.page, (x) => x.net?.mission === 0, 10_000, 'B\'s own mission is over')
    console.log(`[referee] A started close air support on top: every tab shows ${JSON.stringify(all.map((x) => sky2(x).mission?.cmd))}; B yielded ${sky2(bEngine).yielded} time(s) and its engine runs mission ${bEngine.net?.mission}`)
    // 3. A leaves: the lowest number still there (B) takes the mission over with the time that was left
    //    (well below the 900 s a mission starts with, so a fresh start would show).
    await C.page.waitForTimeout(25_000)
    const left = sky2(await waitForBeacon(C.page, () => true, 5_000, 'C')).mission!.seconds
    await A.ctx.close()
    const b3 = await waitForBeacon(Bt.page, (x) => sky2(x).mission?.cmd === 13 && sky2(x).mission?.owner === 0, 20_000, 'B takes it over')
    const c3 = await waitForBeacon(C.page, (x) => sky2(x).mission?.cmd === 13 && sky2(x).mission?.owner === ids[1], 20_000, 'C shows B\'s')
    console.log(`[referee] A left with ${left} s on the clock: B runs it now with ${sky2(b3).mission?.seconds} s (took over ${sky2(b3).adopted}x), C shows ${JSON.stringify(sky2(c3).mission)} (took over ${sky2(c3).adopted}x)`)
    expect(sky2(b3).adopted).toBe(1); expect(sky2(c3).adopted).toBe(0)
    expect(Math.abs(sky2(b3).mission!.seconds - left)).toBeLessThan(15)
    expect(sky2(b3).mission!.seconds).toBeLessThan(885)
  } finally { await A.ctx.close().catch(() => {}); await Bt.ctx.close(); await C.ctx.close() }
})

test('three tabs: the third watches one shoot the other down, and all three (and a newcomer) keep the same score', async ({ browser }) => {
  test.setTimeout(400_000)
  const sky = `tri${Date.now() % 100000}`
  const T = await openTab(browser, sky, 'T'), S = await openTab(browser, sky, 'S'), W = await openTab(browser, sky, 'W')
  let N: Awaited<ReturnType<typeof openTab>> | null = null
  try {
    await T.page.evaluate(go, ['B747', 'RW01_01'])
    await waitForBeacon(T.page, (x) => !!mine(x), 40_000, 'T out')
    await S.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_04'])
    await waitForBeacon(S.page, (x) => !!mine(x) && !!other(x) && x.seat !== null, 40_000, 'S out')
    const w0 = await waitForBeacon(W.page, (x) => x.aircraft.filter((q) => q.alive && !q.player).length === 2, 20_000, 'W sees both')
    console.log(`[three] the watcher sees ${JSON.stringify(w0.aircraft.filter((q) => q.alive).map((q) => q.name))}`)
    await S.page.mouse.click(640, 360)
    for (let i = 0; i < 20; i++) await S.page.keyboard.press('q')
    const dist = (x: Beacon) => { const m = mine(x)!, o = x.aircraft.find((q) => q.alive && !q.player && /T$/.test(q.name)); return o ? Math.hypot(m.pos[0] - o.pos[0], m.pos[2] - o.pos[2]) : NaN }
    await waitForBeacon(S.page, (x) => !!mine(x) && dist(x) < 240, 30_000, 'S within 240 m')
    await S.page.keyboard.down('a'); await S.page.keyboard.down('Shift')
    const wDown = await waitForBeacon(W.page, (x) => !x.aircraft.some((q) => q.alive && /T$/.test(q.name)), 30_000, 'the watcher sees T go down')
    await S.page.keyboard.up('Shift'); await S.page.keyboard.up('a')
    const scores = await Promise.all([T, S, W].map((t) => waitForBeacon(t.page, (x) => sky2(x).kills > 0, 10_000, 'the kill is counted')))
    if (process.env.YSFX_SHOTS) { await T.page.screenshot({ path: `${process.env.YSFX_SHOTS}/three-t-after.png` }); await T.page.waitForTimeout(4000); await T.page.screenshot({ path: `${process.env.YSFX_SHOTS}/three-t-after-4s.png` }); await W.page.screenshot({ path: `${process.env.YSFX_SHOTS}/three-w-after.png` }) }
    console.log(`[three] the watcher saw T go down (it still sees S: ${wDown.aircraft.some((q) => q.alive && /S$/.test(q.name))}); score on T ${JSON.stringify(sky2(scores[0]).scores)} | on S ${JSON.stringify(sky2(scores[1]).scores)} | on the watcher ${JSON.stringify(sky2(scores[2]).scores)}`)
    expect(JSON.stringify(sky2(scores[2]).scores)).toBe(JSON.stringify(sky2(scores[0]).scores))
    expect(JSON.stringify(sky2(scores[1]).scores)).toBe(JSON.stringify(sky2(scores[0]).scores))
    N = await openTab(browser, sky, 'N')
    const n = await waitForBeacon(N.page, (x) => Object.keys(sky2(x).scores).length > 0, 15_000, 'the newcomer is handed the score')
    console.log(`[three] a newcomer's score ${JSON.stringify(sky2(n).scores)}`)
    expect(JSON.stringify(sky2(n).scores)).toBe(JSON.stringify(sky2(scores[0]).scores))
  } finally { await T.ctx.close(); await S.ctx.close(); await W.ctx.close(); await N?.ctx.close() }
})

test('intercept mission: its aircraft exist on the other browser where their owner has them, and the mission shows there', async ({ browser }) => {
  // Runs until the attackers have hit the base (up to five minutes).  Before engine/build.sh kept the
  // null checks of the legacy list code, a tab in this mission would sometimes stop answering by then.
  test.setTimeout(540_000)
  const sky = `int${Date.now() % 100000}`
  const M = await openTab(browser, sky, 'M'), V = await openTab(browser, sky, 'V')
  const unnamed = (x: Beacon) => x.aircraft.filter((q) => q.alive && !q.player && q.name === '')
  try {
    await M.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'RW01_01'])
    await waitForBeacon(M.page, (x) => !!mine(x), 40_000, 'M out')
    await cmd(M.page, 10)
    await waitForBeacon(M.page, (x) => ((x as M2).peer?.owned ?? 0) > 1, 60_000, 'the mission makes aircraft')
    for (let i = 0; i < 4; i++) {
      await M.page.waitForTimeout(8000)
      const [xm, xv] = await Promise.all([waitForBeacon(M.page, () => true, 5_000, 'M'), waitForBeacon(V.page, () => true, 5_000, 'V')]) as S2[]
      const apart = unnamed(xm).map((o) => Math.min(...unnamed(xv).map((c) => d3(o.pos, c.pos)), Infinity))
      console.log(`[intercept] +${(i + 1) * 8}s: M owns ${xm.peer!.owned} (its mission's aircraft: ${unnamed(xm).length}) | V sees ${unnamed(xv).length}, nearest to each (m): ${JSON.stringify(apart.map((a) => Math.round(a)))} (beacons ${xv.t - xm.t} ms apart) | V shows mission ${JSON.stringify(sky2(xv).mission)}`)
      if (i === 3) { expect(unnamed(xv).length).toBe(unnamed(xm).length); expect(sky2(xv).mission?.cmd).toBe(10) }
    }
    // What the attackers destroy on the base is destroyed on V too.
    let hit = false
    for (let i = 0; i < 27 && !hit; i++) {
      await M.page.waitForTimeout(10_000)
      const [xm, xv] = await Promise.all([waitForBeacon(M.page, () => true, 5_000, 'M'), waitForBeacon(V.page, () => true, 5_000, 'V')]) as S2[]
      hit = gnd(xm).damage > 0
      if (hit || i % 6 === 5) console.log(`[intercept] +${32 + (i + 1) * 10}s: M owns ${xm.peer!.owned}, steps ${xm.steps} | field ground [dead, damage] on M ${JSON.stringify([gnd(xm).dead, gnd(xm).damage])} (it told ${gnd(xm).hitsOut} hits) on V ${JSON.stringify([gnd(xv).dead, gnd(xv).damage])} (it took ${gnd(xv).hitsIn}) | launches M told ${(xm as unknown as AirP).peer!.launches.out}, V replayed ${(xv as unknown as AirP).peer!.launches.shown}`)
    }
    if (hit) {
      const xm = await waitForBeacon(M.page, () => true, 5_000, 'M') as S2
      const xv = await waitForBeacon(V.page, (x) => gnd(x).damage === gnd(xm).damage && gnd(x).dead === gnd(xm).dead, 15_000, 'V has the same ground damage') as S2
      console.log(`[intercept] the base was hit: field ground [dead, damage] on M ${JSON.stringify([gnd(xm).dead, gnd(xm).damage])}, on V ${JSON.stringify([gnd(xv).dead, gnd(xv).damage])}`)
    } else console.log('[intercept] the attackers did not hit the base within five minutes: not observed')
    await cmd(M.page, 14)
    await waitForBeacon(V.page, (x) => sky2(x).mission === null && unnamed(x).length === 0, 20_000, 'over on V')
    console.log(`[intercept] terminated: V shows no mission and no mission aircraft`)
  } finally { await M.ctx.close(); await V.ctx.close() }
})

test('flares, bombs and rockets launched by one tab are replayed on the other', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `lch${Date.now() % 100000}`
  const T = await openTab(browser, sky, 'T'), S = await openTab(browser, sky, 'S')
  const L = (x: Beacon) => (x as unknown as AirP).peer!.launches
  try {
    await T.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'NORTH10000_01'])
    await waitForBeacon(T.page, (x) => !!mine(x), 40_000, 'T out')
    // Four bombs and a rocket pod for the shooter (FSWEAPONTYPE 3 and 4), on top of the default load.
    await S.page.evaluate(() => (window as unknown as { __ysfxLoadout: (a: string, c: Array<[number, number]>) => unknown }).__ysfxLoadout('F-16C_FIGHTINGFALCON', [[3, 4], [4, 19]]))
    await S.page.evaluate(go, ['F-16C_FIGHTINGFALCON', 'SOUTH10000_01'])
    await waitForBeacon(S.page, (x) => !!mine(x) && !!other(x) && x.seat !== null, 40_000, 'S out')
    await S.page.mouse.click(640, 360)
    for (const [label, re] of [['flare', /FLARE|FLR/], ['bomb', /BOMB|B500|B250/], ['rocket', /RKT/]] as Array<[string, RegExp]>) {
      await selectWeapon(S.page, re)
      const sel = (await waitForBeacon(S.page, () => true, 5_000, 'S')).hud?.[2] ?? ''
      const s0 = L(await waitForBeacon(S.page, () => true, 5_000, 'S')).out, t0 = L(await waitForBeacon(T.page, () => true, 5_000, 'T')).shown
      if (!re.test(sel)) { console.log(`[launch] ${label}: could not be selected (the weapon line reads "${sel}"): not tried`); continue }
      for (let i = 0; i < 2; i++) { await S.page.keyboard.down('Shift'); await S.page.waitForTimeout(250); await S.page.keyboard.up('Shift'); await S.page.waitForTimeout(900) }
      await S.page.waitForTimeout(800)
      const s1 = L(await waitForBeacon(S.page, () => true, 5_000, 'S')).out, t1 = L(await waitForBeacon(T.page, () => true, 5_000, 'T')).shown
      console.log(`[launch] ${label} ("${sel}"): S told ${s1 - s0}, T's engine replayed ${t1 - t0}`)
      expect(t1 - t0).toBe(s1 - s0)
    }
    console.log(`[launch] both still flying: S ${!!mine(await waitForBeacon(S.page, () => true, 5_000, 'S'))}, T ${!!mine(await waitForBeacon(T.page, () => true, 5_000, 'T'))}`)
  } finally { await T.ctx.close(); await S.ctx.close() }
})

test('the browser that runs the mission freezes without leaving: the next one takes it over', async ({ browser }) => {
  test.setTimeout(300_000)
  const sky = `frz${Date.now() % 100000}`
  const A = await openTab(browser, sky, 'A'), Bt = await openTab(browser, sky, 'B')
  try {
    await waitForBeacon(Bt.page, (x) => sky2(x).roster.length === 1, 20_000, 'B sees A')
    await cmd(A.page, 11)
    const seen = await waitForBeacon(Bt.page, (x) => sky2(x).mission?.cmd === 11 && sky2(x).mission!.owner !== 0, 15_000, 'B shows A\'s mission')
    await Bt.page.waitForTimeout(12_000)
    // A's page stops dead (paused in the debugger): its connection stays open, nothing comes from it.
    const cdp = await A.ctx.newCDPSession(A.page)
    await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause')
    const t0 = Date.now()
    const took = await waitForBeacon(Bt.page, (x) => sky2(x).mission?.cmd === 11 && sky2(x).mission!.owner === 0, 30_000, 'B takes the mission over')
    console.log(`[freeze] A (sender ${sky2(seen).mission!.owner}) froze: B runs the mission after ${Date.now() - t0} ms with ${sky2(took).mission!.seconds} s left (took over ${sky2(took).adopted}x); B still sees A's aircraft copies: ${(took as S2).peer!.peers}`)
    expect(sky2(took).mission!.seconds).toBeLessThan(892)
    // A comes back: two browsers now run the mission, and the lower number's stays.
    await cdp.send('Debugger.resume')
    await Bt.page.waitForTimeout(8000)
    const [xa, xb] = await Promise.all([waitForBeacon(A.page, () => true, 5_000, 'A'), waitForBeacon(Bt.page, () => true, 5_000, 'B')])
    console.log(`[freeze] A is back: A shows ${JSON.stringify(sky2(xa).mission)}, B shows ${JSON.stringify(sky2(xb).mission)} (B yielded ${sky2(xb).yielded}x)`)
    expect(sky2(xa).mission?.cmd).toBe(11); expect(sky2(xb).mission?.cmd).toBe(11)
  } finally { await A.ctx.close(); await Bt.ctx.close() }
})

// Not tested: "a copy that dies here while its owner flies on is made again after two seconds" (the
// engine's FsVrPeerDrain).  A weapon cannot set that up: the state a copy receives carries its owner's
// damage, so a hit the owner ignores does not bring the copy down either (tried 2026-11-22 with the
// owner throwing hits away: the copy flew on).  Only a copy running into something here would.

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
