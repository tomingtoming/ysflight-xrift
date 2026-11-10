/**
 * The engine's original standby screen (console + standby dialog), rendered
 * off-screen.  Same arrangement as hudTarget.ts: a plain RGBA8 texture and
 * framebuffer on the shared context, published in the fsvr menu block
 * (FsVrMenuDataPointer: enable, fbo, texture, width, height, drawn).
 */
import { ExternalTexture, LinearFilter, SRGBColorSpace } from 'three'
import type { YsflightModule } from './types'

export const MENU_W = 1024
export const MENU_H = 768

interface GlTables {
  textures: (WebGLTexture | null)[]
  framebuffers: (WebGLFramebuffer | null)[]
  getNewId: (table: unknown[]) => number
}

export interface MenuTarget {
  texture: ExternalTexture
  /** True once the engine has drawn into the texture since the last call. */
  takeDrawn: () => boolean
  dispose: () => void
}

export function createMenuTarget(m: YsflightModule, gl: WebGL2RenderingContext): MenuTarget | null {
  const GL = (m as unknown as { GL?: GlTables }).GL
  if (!GL || !m._FsVrMenuDataPointer) return null
  const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  const tex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE15)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, MENU_W, MENU_H)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, prevTex)
  gl.activeTexture(prevActive)

  // The console clears colour and depth; give it a depth buffer of its own.
  const rb = gl.createRenderbuffer()!
  const prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING) as WebGLRenderbuffer | null
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, MENU_W, MENU_H)
  gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb)

  const fb = gl.createFramebuffer()!
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb)
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb)
  if (st !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn(`[ysf] menu framebuffer incomplete 0x${st.toString(16)}; standby board disabled`)
    gl.deleteFramebuffer(fb)
    gl.deleteRenderbuffer(rb)
    gl.deleteTexture(tex)
    return null
  }

  const fbId = GL.getNewId(GL.framebuffers)
  GL.framebuffers[fbId] = fb
  ;(fb as unknown as { name: number }).name = fbId
  const texId = GL.getNewId(GL.textures)
  GL.textures[texId] = tex
  ;(tex as unknown as { name: number }).name = texId

  const p = m._FsVrMenuDataPointer() >> 2
  const f = m.HEAPF32
  f[p] = 1
  f[p + 1] = fbId
  f[p + 2] = texId
  f[p + 3] = MENU_W
  f[p + 4] = MENU_H
  f[p + 5] = 0
  f[p + 6] = 0
  f[p + 7] = 0

  const texture = new ExternalTexture(tex)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  console.log(`[ysf] menu target ${MENU_W}x${MENU_H} (fb ${fbId}, tex ${texId})`)
  return {
    texture,
    takeDrawn: () => {
      const d = m.HEAPF32[p + 5] !== 0
      m.HEAPF32[p + 5] = 0
      return d
    },
    dispose: () => {
      m.HEAPF32[p] = 0
      try { gl.deleteFramebuffer(fb) } catch { /* context lost */ }
      try { gl.deleteRenderbuffer(rb) } catch { /* context lost */ }
      try { gl.deleteTexture(tex) } catch { /* context lost */ }
      GL.framebuffers[fbId] = null
      GL.textures[texId] = null
    },
  }
}
