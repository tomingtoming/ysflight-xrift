import { test } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'
// Does a lone tab running the intercept mission stop answering?  Not part of the suite: it runs only
// when YSFX_HANG_URL names the mode ("?ysfxnet=host:12345678" the ordinary host, "?ysfxpeer=x:H" the trial).
// When the page stops answering it pauses it and prints the call stack (build the engine with
// YSFX_PROFILING=1 for function names).  Seen 2026-11-21, twice in five runs of the trial build in host
// mode: stuck in YsSword::ConvexnizeGo <- YsShellExtDrawingBuffer::RemakePolygonBuffer <- the shadow pass,
// i.e. while a model part is prepared for drawing the first time it shows.
test('hang probe', async ({ page }) => {
  test.skip(!process.env.YSFX_HANG_URL, 'set YSFX_HANG_URL to run')
  test.setTimeout(420_000)
  const lines: string[] = []
  page.on('console', (m) => { const t = m.text(); if (/\[ysf\]/.test(t)) { lines.push(t.slice(0, 160)); if (lines.length > 12) lines.shift() } })
  page.on('pageerror', (e) => console.log('[hang] pageerror', String(e).slice(0, 300)))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Debugger.enable')
  let stacks = 0
  cdp.on('Debugger.paused', async (e: { callFrames: Array<{ functionName: string; url: string; location: { lineNumber: number; columnNumber: number } }> }) => {
    console.log(`[hang] stack ${++stacks}:\n` + e.callFrames.slice(0, 22).map((f) => `      ${f.functionName || '(anonymous)'}  ${f.url.split('/').pop()}:${f.location.lineNumber}:${f.location.columnNumber}`).join('\n'))
    await cdp.send('Debugger.resume').catch(() => {})
  })
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/${process.env.YSFX_HANG_URL}`)
  await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 90_000, 'lobby')
  await page.evaluate(() => (window as any).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  await waitForBeacon(page, (x) => x.aircraft.some((a) => a.alive && a.player), 40_000, 'out')
  await page.evaluate(() => (window as any).__ysfxNetCommand(10))
  let last = -1, stuck = 0
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const b = await Promise.race([page.evaluate(() => { const d = (window as any).__ysfxTestBeacon; return d ? { steps: d.steps, t: d.t, n: d.aircraft.length, alive: d.aircraft.filter((a: any) => a.alive).length, mission: d.net?.mission, state: d.net?.state } : null }), new Promise((r) => setTimeout(() => r('NO ANSWER'), 4000))]) as any
    if (b === 'NO ANSWER') { console.log(`[hang] +${(i + 1) * 5}s: the page does not answer (main thread busy). last engine lines: ${JSON.stringify(lines.slice(-6))}`); stuck++; await cdp.send('Debugger.pause').catch((x) => console.log('[hang] pause failed', String(x).slice(0, 100))); await new Promise((r) => setTimeout(r, 1500)); if (stuck >= 4) break; continue }
    if (b && b.steps === last) { console.log(`[hang] +${(i + 1) * 5}s: answers but the engine has not stepped (steps ${b.steps}) ${JSON.stringify(b)}`); stuck++; if (stuck >= 3) break } else stuck = 0
    last = b?.steps ?? last
    if (i % 6 === 5) console.log(`[hang] +${(i + 1) * 5}s ok ${JSON.stringify(b)}`)
  }
  console.log(`[hang] end: ${stuck >= 3 ? 'STUCK' : 'ran the whole 300 s'}`)
})
