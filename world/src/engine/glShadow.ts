/**
 * glShadow — answers the engine's GL state queries without asking the GPU
 * process, for the length of one engine draw.
 *
 * The engine (ysgl) brackets nearly every draw with save/restore queries:
 * GL_CURRENT_PROGRAM on every renderer activation, GL_FRONT_FACE once per
 * model node, the viewport and the blend function here and there -- about
 * 1,500 getParameter calls per draw on the apron at Atsugi.  In WebGL each
 * one is a synchronous round trip toward the GPU process: measured here at
 * ~11 of the draw's ~13 ms on a desktop GPU, and the draw runs once per eye.
 * ysflight-web met the same thing in VR and shadows these states in its
 * shell (web/index.html, "WebGL state shadow"); this is that fix for a
 * context the engine does not own.
 *
 * The context belongs to the host, so nothing is installed for good: for
 * one draw the six methods are wrapped on the context object, and put back
 * after it (a context that refuses the wrapping gets a plain draw).  A
 * shadowed value starts unknown; the first query of it goes to
 * the real getParameter (unless a setter came first), so what the host left
 * in the context is read, not assumed.  Every other pname goes straight
 * through.
 */
const CURRENT_PROGRAM = 0x8b8d
const FRONT_FACE = 0x0b46
const VIEWPORT = 0x0ba2
const BLEND_SRC_RGB = 0x80c9
const BLEND_DST_RGB = 0x80c8
const BLEND_SRC_ALPHA = 0x80cb
const BLEND_DST_ALPHA = 0x80ca

/** Queries answered from the shadow / passed to the context, since page load (tests, gauges). */
export const shadowStats = { answered: 0, passed: 0 }

export function withStateShadow(gl: WebGL2RenderingContext, draw: () => void): void {
  const real = { useProgram: gl.useProgram, frontFace: gl.frontFace, viewport: gl.viewport, blendFunc: gl.blendFunc, blendFuncSeparate: gl.blendFuncSeparate, getParameter: gl.getParameter }
  // undefined = not known yet
  let program: WebGLProgram | null | undefined
  let front: number | undefined
  let vp: Int32Array | undefined
  let srcRGB: number | undefined
  let dstRGB: number | undefined
  let srcA: number | undefined
  let dstA: number | undefined
  const ask = (pname: number) => { shadowStats.passed++; return real.getParameter.call(gl, pname) }

  const restore = () => {
    gl.useProgram = real.useProgram
    gl.frontFace = real.frontFace
    gl.viewport = real.viewport
    gl.blendFunc = real.blendFunc
    gl.blendFuncSeparate = real.blendFuncSeparate
    gl.getParameter = real.getParameter
  }
  // The context is the host's: if it refuses the wrapping, draw without the shadow rather than not at all.
  let installed = false
  try {
    gl.useProgram = function (p: WebGLProgram | null) { program = p ?? null; real.useProgram.call(gl, p) }
    gl.frontFace = function (m: number) { front = m; real.frontFace.call(gl, m) }
    gl.viewport = function (x: number, y: number, w: number, h: number) { vp = new Int32Array([x, y, w, h]); real.viewport.call(gl, x, y, w, h) }
    gl.blendFunc = function (s: number, d: number) { srcRGB = srcA = s; dstRGB = dstA = d; real.blendFunc.call(gl, s, d) }
    gl.blendFuncSeparate = function (sr: number, dr: number, sa: number, da: number) { srcRGB = sr; dstRGB = dr; srcA = sa; dstA = da; real.blendFuncSeparate.call(gl, sr, dr, sa, da) }
    gl.getParameter = function (pname: number) {
      switch (pname) {
        case CURRENT_PROGRAM: if (program === undefined) program = ask(pname) as WebGLProgram | null; else shadowStats.answered++; return program
        case FRONT_FACE: if (front === undefined) front = ask(pname) as number; else shadowStats.answered++; return front
        case VIEWPORT: if (vp === undefined) vp = ask(pname) as Int32Array; else shadowStats.answered++; return new Int32Array(vp) // a fresh copy, like the real call
        case BLEND_SRC_RGB: if (srcRGB === undefined) srcRGB = ask(pname) as number; else shadowStats.answered++; return srcRGB
        case BLEND_DST_RGB: if (dstRGB === undefined) dstRGB = ask(pname) as number; else shadowStats.answered++; return dstRGB
        case BLEND_SRC_ALPHA: if (srcA === undefined) srcA = ask(pname) as number; else shadowStats.answered++; return srcA
        case BLEND_DST_ALPHA: if (dstA === undefined) dstA = ask(pname) as number; else shadowStats.answered++; return dstA
      }
      shadowStats.passed++
      return real.getParameter.call(gl, pname)
    }
    installed = true
  } catch {
    restore()
  }
  if (!installed) { draw(); return }
  try {
    draw()
  } finally {
    restore()
  }
}
