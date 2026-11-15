/**
 * glProbe — reads back, from the context itself, state that decides whether
 * things near the ground are hidden by it: the depth buffer the engine draws
 * into, and the z-offset uniforms of every engine program.
 *
 * Why: on a Quest 3 the kiosk's preview aircraft sinks into the apron when
 * seen from above, more the higher the viewer (2026-11-15); a desktop GPU
 * does not show it, in a flat window or in an emulated XR session.  One
 * candidate is a z-offset that belongs to the point-sprite program (runway
 * lights, -0.01) ending up on a program that draws the ground: Emscripten
 * numbers uniform locations in the driver's own order, per program.
 *
 * Every read is a synchronous round trip, so this runs once in a few
 * seconds, right after an engine draw while the engine's target is bound.
 */
import type { YsflightModule } from './types'

interface GlRuntime { programs: Array<WebGLProgram | null> }

export function probeGl(m: YsflightModule, gl: WebGL2RenderingContext): string {
  const parts: string[] = []
  try {
    parts.push(`深度 ${gl.getParameter(gl.DEPTH_BITS)}bit x${gl.getParameter(gl.SAMPLES)}`)
    const rt = (m as unknown as { GL?: GlRuntime }).GL
    const off: string[] = []
    let n = 0
    rt?.programs.forEach((p, id) => {
      if (!p) return
      const lu = gl.getUniformLocation(p, 'useZOffset')
      const lz = gl.getUniformLocation(p, 'zOffset')
      if (!lu && !lz) return
      n++
      const use = lu ? !!gl.getUniform(p, lu) : false
      const z = lz ? (gl.getUniform(p, lz) as number) : 0
      if (use || z !== 0) off.push(`${id}:${use ? '' : '('}${z.toPrecision(1)}${use ? '' : ')'}`)
    })
    parts.push(`Zずらし ${off.length}/${n}${off.length ? ' ' + off.join(' ') : ''}`)
  } catch (e) {
    parts.push(`probe failed: ${String(e).slice(0, 60)}`)
  }
  return parts.join('  ')
}
