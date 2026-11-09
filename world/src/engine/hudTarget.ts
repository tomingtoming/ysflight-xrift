/**
 * The engine's real flat HUD, rendered off-screen.
 *
 * The engine renders its in-flight HUD into a framebuffer the host publishes
 * in the fsvr HUD block (FsVrHudDataPointer: enable, fbo, texture, width,
 * height).  We allocate a plain 2D RGBA8 texture + framebuffer on the shared
 * WebGL context, register both in Emscripten's GL handle tables so the C++
 * side can bind them by integer name, and wrap the texture for three.js
 * (ExternalTexture) so a mesh in the cockpit can show it.
 */
import { ExternalTexture, LinearFilter, SRGBColorSpace } from 'three'
import type { YsflightModule } from './types'

export const HUD_W = 768
export const HUD_H = 432

interface GlTables {
  textures: (WebGLTexture | null)[]
  framebuffers: (WebGLFramebuffer | null)[]
  getNewId: (table: unknown[]) => number
}

export interface HudTarget {
  texture: ExternalTexture
  dispose: () => void
}

export function createHudTarget(m: YsflightModule, gl: WebGL2RenderingContext): HudTarget | null {
  const GL = (m as unknown as { GL?: GlTables }).GL
  if (!GL) {
    console.warn('[ysf] no GL runtime table; HUD glass disabled')
    return null
  }
  const prevActive = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null
  const tex = gl.createTexture()!
  gl.activeTexture(gl.TEXTURE15)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, HUD_W, HUD_H)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.bindTexture(gl.TEXTURE_2D, prevTex)
  gl.activeTexture(prevActive)

  const fb = gl.createFramebuffer()!
  const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
  gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb)
  if (st !== gl.FRAMEBUFFER_COMPLETE) {
    console.warn(`[ysf] HUD framebuffer incomplete 0x${st.toString(16)}; HUD glass disabled`)
    gl.deleteFramebuffer(fb)
    gl.deleteTexture(tex)
    return null
  }

  const fbId = GL.getNewId(GL.framebuffers)
  GL.framebuffers[fbId] = fb
  ;(fb as unknown as { name: number }).name = fbId
  const texId = GL.getNewId(GL.textures)
  GL.textures[texId] = tex
  ;(tex as unknown as { name: number }).name = texId

  const p = m._FsVrHudDataPointer() >> 2
  const f = m.HEAPF32
  f[p] = 1
  f[p + 1] = fbId
  f[p + 2] = texId
  f[p + 3] = HUD_W
  f[p + 4] = HUD_H
  f[p + 5] = 0
  f[p + 6] = 0 // reticle stays baked into the flat HUD (the per-eye reticle is multiview-only)
  f[p + 7] = 0

  const texture = new ExternalTexture(tex)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = false
  console.log(`[ysf] HUD target ${HUD_W}x${HUD_H} (fb ${fbId}, tex ${texId})`)
  return {
    texture,
    dispose: () => {
      f[p] = 0
      try { gl.deleteFramebuffer(fb) } catch { /* context lost */ }
      try { gl.deleteTexture(tex) } catch { /* context lost */ }
      GL.framebuffers[fbId] = null
      GL.textures[texId] = null
    },
  }
}
