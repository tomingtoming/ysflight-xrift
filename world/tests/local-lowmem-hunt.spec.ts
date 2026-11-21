import { test, type Page } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'
// Not part of the suite (YSFX_HUNT=<tabs> runs it): several lone host tabs run the intercept mission
// for five minutes.  It watches two things: a tab that stops answering (its call stack is printed; build
// with YSFX_PROFILING=1 for names), and the first kilobyte of the engine's memory, where nothing lives.
// 2026-11-21: without -fno-delete-null-pointer-checks (engine/build.sh) bytes 60 and 124 filled in after
// about two minutes in every tab, in the production build too, and three tabs in nineteen stopped
// answering; with it, five tabs of five stayed clean.  YSFX_ASAN=1 builds print what AddressSanitizer says.
test('hang hunt', async ({ browser }) => {
  test.skip(!process.env.YSFX_HUNT, 'set YSFX_HUNT=<tabs> to run')
  test.setTimeout(480_000)
  const N = Number(process.env.YSFX_HUNT)
  const tabs: Array<{ page: Page; lines: string[]; made: string[]; cdp: any; stuck: number; done: boolean }> = []
  for (let k = 0; k < N; k++) {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    const lines: string[] = [], made: string[] = []
    let san = 0
    page.on('console', (m) => { const t = m.text(); if (/Sanitizer|==\d+==|SUMMARY|^\[ysf\]\s+#\d+ |abort|is located|freed by|allocated by|READ of|WRITE of/.test(t) && san++ < 60) console.log(`[hunt] tab ${k} SAN: ${t.slice(0, 260)}`); if (/PEERDBG AddAirplane/.test(t)) made.push(t.replace(/.*AddAirplane /, '')); else if (/PEERDBG/.test(t)) { lines.push(t.replace(/.*PEERDBG /, '')); if (lines.length > 6) lines.shift() } })
    const cdp = await ctx.newCDPSession(page); await cdp.send('Debugger.enable')
    cdp.on('Debugger.paused', async (e: any) => { console.log(`[hunt] tab ${k} stack:\n` + e.callFrames.slice(0, 9).map((f: any) => `      ${f.functionName || '(anonymous)'}`).join('\n')); await cdp.send('Debugger.resume').catch(() => {}) })
    await watchBeacon(page)
    await page.goto(`http://localhost:5173/?ysfxnet=host:${10000000 + Math.floor(Math.random() * 80000000)}`)
    tabs.push({ page, lines, made, cdp, stuck: 0, done: false })
  }
  for (const t of tabs) { await waitForBeacon(t.page, (x) => !!x.lobby && x.lobby[0] > 10, 120_000, 'lobby'); await t.page.evaluate(() => (window as any).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01')) }
  for (const t of tabs) { await waitForBeacon(t.page, (x) => x.aircraft.some((a) => a.alive && a.player), 60_000, 'out'); await t.page.evaluate(() => (window as any).__ysfxNetCommand(10)) }
  console.log(`[hunt] ${N} tabs running the intercept mission (engine ${await tabs[0].page.evaluate(() => (window as any).__ysfxTestBeacon?.engine)})`)
  let found = 0
  for (let i = 0; i < 60 && found < N; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    for (const [k, t] of tabs.entries()) {
      if (t.done) continue
      // The first 1024 bytes of the engine's memory: nothing lives there, and legacy list code reads it as "empty list".
      const a = await Promise.race([t.page.evaluate(() => { const m = (window as any).__ysfx; if (!m) return 'no module'; const h = m.HEAPU8 as Uint8Array; const dirty: number[][] = []; for (let o = 0; o < 1024 && dirty.length < 24; o++) if (h[o] !== 0) dirty.push([o, h[o]]); return dirty.length ? JSON.stringify(dirty) : '' }), new Promise((r) => setTimeout(() => r('NO ANSWER'), 3000))]) as string
      if (a !== 'NO ANSWER') { t.stuck = 0; if (a && a !== (t as any).dirtyWas) { (t as any).dirtyWas = a; console.log(`[hunt] tab ${k} at about +${(i + 1) * 5}s: low memory is not all zero: [offset, byte] ${a}. aircraft made: ${JSON.stringify(t.made)}; last: ${JSON.stringify(t.lines.slice(-1))}`) } continue }
      if (++t.stuck < 2) continue
      t.done = true; found++
      console.log(`[hunt] tab ${k} stopped answering at about +${(i + 1) * 5}s. aircraft made: ${JSON.stringify(t.made)}. last from the shadow pass: ${JSON.stringify(t.lines.slice(-3))}`)
      await t.cdp.send('Debugger.pause').catch(() => {}); await new Promise((r) => setTimeout(r, 1500))
    }
  }
  for (const [k, t] of tabs.entries()) if (!t.done) console.log(`[hunt] tab ${k} ran the whole time. aircraft made: ${JSON.stringify(t.made)}`)
  console.log(`[hunt] end: ${found} of ${N} stopped`)
})
