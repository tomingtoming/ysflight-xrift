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

// In the air: the target starts at 10,000 ft, the shooter starts from the same
// place a few seconds later -- same aircraft, no input, so it flies the same path
// behind it with the target dead ahead.
type AirP = B & { peer?: { hitsOut: number; hitsIn: number; stateAge: { n: number; sum: number; max: number }; hitAge: { n: number; sum: number; max: number } } }
const own = (x: Beacon) => x.aircraft.find((q) => q.player)
const copy = (x: Beacon) => x.aircraft.find((q) => !q.player)
const d3 = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
async function airPair(browser: import('@playwright/test').Browser, sky: string, gapMs: number) {
  const ctxT = await browser.newContext(); const t = await ctxT.newPage(); await watchBeacon(t)
  const ctxS = await browser.newContext(); const sh = await ctxS.newPage(); await watchBeacon(sh)
  const lag = process.env.YSFX_LAG ? `&ysfxlag=${process.env.YSFX_LAG}` : '' // e.g. 100:30 -- both tabs hold what they receive
  await t.goto(`http://localhost:5173/?ysfxpeer=${sky}:T${lag}`)
  await sh.goto(`http://localhost:5173/?ysfxpeer=${sky}:S${lag}`)
  await waitForBeacon(t, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'T lobby')
  await waitForBeacon(sh, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'S lobby')
  await t.evaluate(go, ['F-16C_FIGHTINGFALCON', 'NORTH10000_01'])
  await waitForBeacon(t, (x) => !!mine(x), 40_000, 'T out')
  await t.waitForTimeout(gapMs)
  await sh.evaluate(go, ['F-16C_FIGHTINGFALCON', 'NORTH10000_01'])
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
    console.log(`[air-gun] ${down ? 'hits reached T' : 'no hit reached T'} (T ${mine(xt) ? 'still flying' : 'no longer flying'}, shot down by the gun: ${(xt.panel?.log ?? []).some((l) => /Shot down by/.test(l))}): S reported ${xs.peer?.hitsOut}, T took ${xt.peer?.hitsIn}; hit age at T (ms) avg ${(xt.peer!.hitAge.sum / Math.max(1, xt.peer!.hitAge.n)).toFixed(1)} max ${xt.peer!.hitAge.max}; state age at S avg ${(xs.peer!.stateAge.sum / Math.max(1, xs.peer!.stateAge.n)).toFixed(1)} max ${xs.peer!.stateAge.max}; S gun ${JSON.stringify((xs.hud ?? []).slice(2, 3))}`)
    if (process.env.YSFX_SHOTS) await sh.screenshot({ path: `${process.env.YSFX_SHOTS}/air-gun-after.png` })
    expect(down).toBeTruthy()
    expect(xt.peer?.hitsIn).toBe(xs.peer?.hitsOut)
  } finally { await close() }
})

test('in the air: a missile from behind', async ({ browser }) => {
  test.setTimeout(300_000)
  const { t, sh, close } = await airPair(browser, `airm${Date.now() % 100000}`, 5000)
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
    if (down) await aftermath(t, sh, 'air-aam')
    expect(down).toBeTruthy()
  } finally { await close() }
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
