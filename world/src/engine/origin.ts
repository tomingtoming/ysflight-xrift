/**
 * Where the engine's world sits in the host's world.
 *
 * The engine's fields are tens of kilometres wide and their runways are
 * wherever the field's author put them: Atsugi's 650 m from the field's
 * origin, Hawaii's 45 km, Tohoku's 53 km.  Until 2026-11-15 the engine's
 * world WAS the host's world, so on Hawaii every visitor stood 45 km from the
 * host's origin -- and did not see the other visitors' avatars there (toming,
 * 2026-11-15; Atsugi and its two-visitor tests were fine).
 *
 * Now the engine's world is translated so that every field's apron lands on
 * the same place in the host's world, the place Atsugi's apron always had:
 *
 *     host = engine - origin
 *
 * The airfield (World.tsx) sets the origin once it has measured the field's
 * apron.  Everything that carries a position across the boundary converts
 * here: aircraft matrices and ground heights coming out, the eye's view
 * matrix, ground queries, the preview's place and the own aircraft's drawn
 * pose going in.  Positions that stay inside the engine's frame on both
 * sides (start positions against aircraft, in the kiosk) are left alone.
 */
import type { Matrix4 } from 'three'

export const origin = {
  x: 0, y: 0, z: 0,
  /** The loaded field's apron has been measured and the origin above belongs to it. */
  ready: false,
  /** Counts every change: holders of converted values start over. */
  rev: 0,
}

export function setOrigin(x: number, y: number, z: number): void {
  origin.x = x; origin.y = y; origin.z = z
  origin.ready = true
  origin.rev++
}

/** Another engine (another field) is loading: the origin is the previous field's until the apron is measured again. */
export function originPending(): void {
  if (!origin.ready) return
  origin.ready = false
  origin.rev++
}

/** A frame -> world matrix of the engine (column-major, 16 floats at f[i]) as a host matrix. */
export function readEngineMatrix(out: Matrix4, f: ArrayLike<number>, i: number): Matrix4 {
  out.fromArray(f, i)
  const e = out.elements
  e[12] -= origin.x; e[13] -= origin.y; e[14] -= origin.z
  return out
}

/** A host frame -> world matrix written for the engine (16 floats at f[i]). */
export function writeEngineMatrix(f: Float32Array, i: number, m: Matrix4): void {
  const e = m.elements
  for (let k = 0; k < 16; k++) f[i + k] = e[k]
  f[i + 12] = e[12] + origin.x; f[i + 13] = e[13] + origin.y; f[i + 14] = e[14] + origin.z
}

/**
 * Dev aid: ?ysfxanchor=dx,dy,dz (or VITE_YSFX_ANCHOR) stands the apron that far from its usual
 * place in the host's world.  On Atsugi the origin is zero and a conversion
 * that was forgotten changes nothing; with this the whole local suite runs
 * with an origin that is not.
 */
export function devAnchorShift(): [number, number, number] {
  if (!import.meta.env.DEV) return [0, 0, 0]
  // The page's query, or VITE_YSFX_ANCHOR in the dev server's environment (the test suite's URLs are fixed).
  const q = /[?&]ysfxanchor=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(location.search) ??
    /^(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$/.exec((import.meta.env.VITE_YSFX_ANCHOR as string | undefined) ?? '')
  return q ? [Number(q[1]), Number(q[2]), Number(q[3])] : [0, 0, 0]
}
