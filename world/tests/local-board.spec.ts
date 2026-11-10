/**
 * local-board: the original standby screen on a board (?ysfxboard=1, trial).
 * The engine renders its console + standby dialog into the menu texture while
 * the player stands on the field; the texture is read back for a visual check.
 */
import { expect, test } from '@playwright/test'
import { NET_FLYING, lastBeacon, waitForBeacon, watchBeacon } from './helpers'

async function dumpMenu(page: import('@playwright/test').Page): Promise<{ png: string; drawn: number; lit: number }> {
  return page.evaluate(() => {
    const m = (window as unknown as { __ysfx: { HEAPF32: Float32Array; _FsVrMenuDataPointer: () => number; GL: { framebuffers: WebGLFramebuffer[] }; canvas?: HTMLCanvasElement } }).__ysfx
    const p = m._FsVrMenuDataPointer() >> 2
    const [fbId, w, h, drawn] = [m.HEAPF32[p + 1], m.HEAPF32[p + 3], m.HEAPF32[p + 4], m.HEAPF32[p + 5]]
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING)
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.GL.framebuffers[fbId])
    const px = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(w, h)
    let lit = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4
        img.data[d] = px[s]; img.data[d + 1] = px[s + 1]; img.data[d + 2] = px[s + 2]; img.data[d + 3] = 255
        if (px[s] + px[s + 1] + px[s + 2] > 300) lit++
      }
    }
    ctx.putImageData(img, 0, 0)
    return { png: c.toDataURL('image/png'), drawn, lit }
  })
}

const tap = (page: import('@playwright/test').Page, x: number, y: number) =>
  page.evaluate(([px, py]) => (window as unknown as { __ysfxBoardTap: (x: number, y: number) => string }).__ysfxBoardTap(px, py), [x, y])

test('original standby screen on the board: shown, choosers open, 飛行開始 boards the player', async ({ page }) => {
  await watchBeacon(page)
  await page.goto('http://localhost:5173/?ysfxnet=host:12345678')
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  await waitForBeacon(page, (b) => b.draws > 120, 20_000, 'engine drawing in standby')
  await page.waitForTimeout(2000)
  const { writeFileSync } = await import('node:fs')
  const save = async (name: string) => {
    const d = await dumpMenu(page)
    writeFileSync(test.info().outputPath(name), Buffer.from(d.png.split(',')[1], 'base64'))
    return d
  }
  const d = await save('board-standby.png')
  console.log(`[board] standby lit pixels ${d.lit}`)
  expect(d.lit).toBeGreaterThan(500)

  // 航空機選択 opens the original chooser on the same board; the field stays drawn.
  await tap(page, 324, 107)
  await page.waitForTimeout(1500)
  const c = await save('board-choose-air.png')
  await page.screenshot({ path: test.info().outputPath('board-world-choosing.png') })
  console.log(`[board] chooser lit pixels ${c.lit}`)
  const before = (await lastBeacon(page))!.draws
  await page.waitForTimeout(500)
  expect((await lastBeacon(page))!.draws).toBeGreaterThan(before)

  // Pick the F-22 in the original list, 確定, then the original 飛行開始.
  await tap(page, 56, 92)
  await page.waitForTimeout(600)
  await tap(page, 24, 377)
  await page.waitForTimeout(1000)
  await save('board-after-choose.png')
  await tap(page, 474, 107)
  const flying = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit' && !!b.net && b.net.state === NET_FLYING && b.net.playerAirId >= 0, 30_000, 'seated and flying from the board')
  const mine = flying.aircraft.find((a) => a.player && a.alive)
  console.log(`[board] flying: ${JSON.stringify(mine)}`)
  expect(mine).toBeTruthy()
})
