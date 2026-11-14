/**
 * local-shadow: the GL state shadow (src/engine/glShadow.ts) answers the
 * engine's state queries during its draw, makes the draw cheaper, and does
 * not change the picture.  On and off are compared in one page, on a parked
 * aircraft, so the scene is the same for both.
 */
import { expect, test, type Page } from '@playwright/test'
import { NET_FLYING, lastBeacon, waitForBeacon, watchBeacon } from './helpers'

const ROOM = '12345683'
const shadow = (page: Page, on: boolean) => page.evaluate((x) => (window as unknown as { __ysfxShadow: (on: boolean) => string }).__ysfxShadow(x), on)

/** Pixels of the engine's canvas that differ by more than 8/255 in any channel. */
async function differing(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(async ([x, y]) => {
    const load = async (b64: string) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width; c.height = img.height
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, c.width, c.height).data
    }
    const [p, q] = [await load(x), await load(y)]
    let n = 0
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 8 || Math.abs(p[i + 1] - q[i + 1]) > 8 || Math.abs(p[i + 2] - q[i + 2]) > 8) n++
    return n
  }, [a.toString('base64'), b.toString('base64')])
}

test('state shadow: queries answered locally, cheaper draw, same picture', async ({ page }) => {
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  await page.evaluate(() => (window as unknown as { __ysfxLobbyStart: (a: string, s: string) => string }).__ysfxLobbyStart('F-16C_FIGHTINGFALCON', 'RW01_01'))
  await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING && !!b.seat, 30_000, 'flying and seated')
  await page.waitForTimeout(6000) // parked, settled

  const read = async (label: string) => {
    const a = (await lastBeacon(page))!
    await page.waitForTimeout(4000)
    const b = (await waitForBeacon(page, (x) => !!x.gauge?.now, 5_000, 'gauge'))!
    const draws = b.draws - a.draws
    const r = { answered: (b.glq!.answered - a.glq!.answered) / draws, passed: (b.glq!.passed - a.glq!.passed) / draws, drawMs: b.gauge!.now!.drawMs, shot: await page.screenshot() }
    console.log(`[shadow] ${label}: per draw ${r.answered.toFixed(0)} answered, ${r.passed.toFixed(1)} passed to the context; draw ${r.drawMs.toFixed(2)} ms`)
    return r
  }
  const on1 = await read('on ')
  await shadow(page, false)
  await page.waitForTimeout(3000) // let the draw-time average follow
  const off = await read('off')
  await shadow(page, true)
  await page.waitForTimeout(3000)
  const on2 = await read('on ')

  // With the shadow nearly every query is answered without the context.
  expect(on1.answered).toBeGreaterThan(100)
  expect(on1.passed).toBeLessThan(20)
  expect(off.answered).toBe(0)
  // The draw is cheaper with it, both times.
  expect(on1.drawMs).toBeLessThan(off.drawMs * 0.7)
  expect(on2.drawMs).toBeLessThan(off.drawMs * 0.7)
  // Same picture: on/off differ no more than on/on does (HUD digits flicker either way).
  const control = await differing(page, on1.shot, on2.shot)
  const ab = Math.max(await differing(page, on1.shot, off.shot), await differing(page, on2.shot, off.shot))
  console.log(`[shadow] differing pixels: on/on ${control}, on/off ${ab}`)
  expect(ab).toBeLessThanOrEqual(control + 200)
})
