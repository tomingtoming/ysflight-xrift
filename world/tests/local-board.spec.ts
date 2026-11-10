/**
 * local-board: the original standby screen on a board (?ysfxboard=1, trial).
 * The engine renders its console + standby dialog into the menu texture while
 * the player stands on the field; the texture is read back for a visual check.
 */
import { expect, test } from '@playwright/test'
import { waitForBeacon, watchBeacon } from './helpers'

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

test('original standby screen renders to the board texture while standing on the field', async ({ page }) => {
  await watchBeacon(page)
  await page.goto('http://localhost:5173/?ysfxnet=host:12345678&ysfxboard=1')
  await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.mode === 1 && b.net.ready, 90_000, 'server ready')
  await waitForBeacon(page, (b) => b.draws > 120, 20_000, 'engine drawing in standby')
  await page.waitForTimeout(2000)
  const d = await dumpMenu(page)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(test.info().outputPath('board-texture.png'), Buffer.from(d.png.split(',')[1], 'base64'))
  await page.screenshot({ path: test.info().outputPath('board-world.png') })
  console.log(`[board] drawn ${d.drawn}, lit pixels ${d.lit}`)
  expect(d.lit).toBeGreaterThan(500)
})
