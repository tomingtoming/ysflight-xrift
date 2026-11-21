/**
 * local-lowmem-hunt: not part of the suite (YSFX_HUNT=<tabs> runs it).
 *
 * Several lone host tabs run the intercept mission for five minutes.  Watched: the first
 * kilobyte of the engine's memory, where nothing lives, and a tab that stops answering.
 *
 * Why: the engine's legacy list code is called on null pointers and tests `this==NULL` itself.
 * Without -fno-delete-null-pointer-checks (engine/build.sh) the compiler drops the test, an
 * append to an empty list writes a heap address into the first bytes of memory, and the next one
 * follows it into freed memory.  2026-11-21: built without the flag (YSFX_KEEP_UB=1), bytes 60
 * and 124 fill in after about two minutes in every tab; with it they stay zero.
 *
 *   YSFX_HUNT=5 YSFX_ARGS="--enable-gpu --use-angle=vulkan --enable-features=Vulkan" \
 *     npx playwright test local-lowmem-hunt --config tests/playwright.config.ts --project=local-pc --trace off
 */
import { expect, test, type Page } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'

type W = { __ysfx?: { HEAPU8: Uint8Array }; __ysfxTestBeacon?: { engine?: string }; __ysfxLobbyStart: (a: string, s: string) => string; __ysfxNetCommand: (c: number) => string }

test('the first kilobyte of engine memory stays empty through a mission', async ({ browser }) => {
  test.skip(!process.env.YSFX_HUNT, 'set YSFX_HUNT=<tabs> to run')
  test.setTimeout(480_000)
  const N = Number(process.env.YSFX_HUNT)
  const tabs: Array<{ page: Page; dirty: string; stuck: number; stopped: boolean }> = []
  for (let k = 0; k < N; k++) {
    const ctx = await browser.newContext(); const page = await ctx.newPage()
    await watchBeacon(page)
    await page.goto(`http://localhost:5173/?ysfxnet=host:${10000000 + Math.floor(Math.random() * 80000000)}`)
    tabs.push({ page, dirty: '', stuck: 0, stopped: false })
  }
  for (const t of tabs) { await waitForBeacon(t.page, (x) => !!x.lobby && x.lobby[0] > 10, 120_000, 'lobby'); await t.page.evaluate(() => (window as unknown as W).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01')) }
  for (const t of tabs) { await waitForBeacon(t.page, (x) => x.aircraft.some((a) => a.alive && a.player), 60_000, 'out'); await t.page.evaluate(() => (window as unknown as W).__ysfxNetCommand(10)) }
  console.log(`[lowmem] ${N} tabs running the intercept mission (engine ${await tabs[0].page.evaluate(() => (window as unknown as W).__ysfxTestBeacon?.engine)})`)
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000))
    for (const [k, t] of tabs.entries()) {
      if (t.stopped) continue
      const a = await Promise.race([
        t.page.evaluate(() => { const m = (window as unknown as W).__ysfx; if (!m) return ''; const h = m.HEAPU8; const d: number[][] = []; for (let o = 0; o < 1024 && d.length < 24; o++) if (h[o] !== 0) d.push([o, h[o]]); return d.length ? JSON.stringify(d) : '' }),
        new Promise<string>((r) => setTimeout(() => r('NO ANSWER'), 3000)),
      ])
      if (a === 'NO ANSWER') { if (++t.stuck >= 2) { t.stopped = true; console.log(`[lowmem] tab ${k} stopped answering at about +${(i + 1) * 5}s`) } continue }
      t.stuck = 0
      if (a && !t.dirty) console.log(`[lowmem] tab ${k} at about +${(i + 1) * 5}s: not all zero, [offset, byte] ${a}`)
      if (a) t.dirty = a
    }
  }
  const dirty = tabs.filter((t) => t.dirty).length, stopped = tabs.filter((t) => t.stopped).length
  console.log(`[lowmem] end: ${dirty} of ${N} tabs with something in the first kilobyte, ${stopped} stopped answering`)
  expect(stopped).toBe(0)
  expect(dirty).toBe(0)
})
