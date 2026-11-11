/**
 * GroundPatch — the ground to stand on wherever the visitor is, hills included.
 *
 * The engine draws the terrain; the host's avatar needs something to walk
 * on.  The apron used to be a flat floor at one elevation (World.tsx) and
 * everywhere else a small flat plate at the height under the feet: right on
 * an airfield and on a carrier deck, wrong on any slope (the avatar walked
 * through the hillside or on air beside it).  Now the engine answers a whole
 * square of heights at once (fsvr.h FsVrGroundGridDataPointer: the field
 * elevation, or the flight deck of a live carrier above it) and this
 * component lays a heightfield collider of that square under the local
 * player, re-centred as they walk and re-asked every second (carriers move).
 *
 * The collider is replaced, never moved: a moved body's displacement is a
 * velocity, and the first move of a kinematic floor threw every visitor on
 * the production host ten kilometres into the sky (v54, 2026-11-10).
 *
 * The single-point probe stays in use for what is exactly under the feet
 * (the beacon's ground check); this component owns it except while the
 * airfield measures the apron elevation (StateBeacon probeBusy).  The grid
 * block is this component's alone.
 */
import { useFrame, useThree } from '@react-three/fiber'
import { HeightfieldCollider, RigidBody } from '@react-three/rapier'
import { useUsers } from '@xrift/world-components'
import { useEffect, useRef, useState } from 'react'
import { Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { readFeet } from './seatLead'
import { isProbeBusy, localSeatId, publishGround, publishPatch } from './StateBeacon'

/** Samples per side and their spacing: a 48 m square, the player at least 20 m from its edge. */
const SIDE = 25
const SPACING = 2 // m
/** The square's centre snaps to this grid, so walking re-centres it every few metres, not every frame. */
const SNAP = 8 // m
/** Ask again this often even when standing still: a carrier under the feet moves, a destroyed one is gone. */
const REFRESH_S = 1
/** A seated pilot needs no floor until they stop and get out: follow at most this often while seated. */
const SEATED_REFRESH_S = 0.25
/** Heights that differ by less than this are the same ground: no rebuild. */
const SAME_M = 0.01

interface Patch { cx: number; cz: number; heights: number[]; build: number }

/** Dev only: lay the patch around this point instead of the player (tests look at slopes far from the apron). */
let devFocus: { x: number; z: number } | null = null
export function setDevPatchFocus(p: { x: number; z: number } | null): void { devFocus = p }

export function GroundPatch({ onReady }: { onReady?: (ready: boolean) => void }) {
  const mod = useEngine()
  const users = useUsers()
  const camera = useThree((s) => s.camera)
  const [patch, setPatch] = useState<Patch | null>(null)
  const current = useRef<Patch | null>(null)
  const asked = useRef<{ x: number; z: number } | null>(null)
  const gridAsked = useRef<{ req: number; cx: number; cz: number } | null>(null)
  const req = useRef(0)
  const since = useRef(Infinity)
  const builds = useRef(0)
  const v = useRef(new Vector3())

  // Another engine is another field: the old heights mean nothing.
  useEffect(() => {
    current.current = null
    gridAsked.current = null
    asked.current = null
    since.current = Infinity
    setPatch(null)
    publishPatch(null)
    onReady?.(false)
  }, [mod, onReady])

  useFrame((_s, dt) => {
    if (!mod) return
    const f = mod.HEAPF32
    const feet = devFocus ? v.current.set(devFocus.x, 0, devFocus.z) : (readFeet(users, v.current) ?? camera.position)

    // Exactly under the feet, for the beacon (one point per engine step).
    if (isProbeBusy()) asked.current = null
    else {
      const gp = mod._FsVrGroundProbeDataPointer() >> 2
      const a = asked.current
      if (a && f[gp + 3] !== 0 && f[gp] === a.x && f[gp + 1] === a.z) publishGround({ height: f[gp + 2], deck: f[gp + 4] !== 0 })
      const x = Math.fround(feet.x), z = Math.fround(feet.z)
      f[gp] = x
      f[gp + 1] = z
      asked.current = { x, z }
    }

    // The square around the feet.
    const gg = mod._FsVrGroundGridDataPointer() >> 2
    const g = gridAsked.current
    if (g && f[gg + 6] !== 0 && f[gg + 5] === g.req) {
      gridAsked.current = null
      const heights = Array.from(f.subarray(gg + 8, gg + 8 + SIDE * SIDE))
      const c = current.current
      let same = !!c && c.cx === g.cx && c.cz === g.cz
      if (same) for (let i = 0; i < heights.length; i++) if (Math.abs(heights[i] - c!.heights[i]) > SAME_M) { same = false; break }
      if (!same) {
        const next: Patch = { cx: g.cx, cz: g.cz, heights, build: ++builds.current }
        current.current = next
        setPatch(next)
        if (!c) onReady?.(true)
        let min = Infinity, max = -Infinity
        for (const h of heights) { if (h < min) min = h; if (h > max) max = h }
        publishPatch({ cx: g.cx, cz: g.cz, n: SIDE, spacing: SPACING, min, max, deckSamples: f[gg + 7], builds: builds.current })
      }
    }
    since.current += dt
    if (!gridAsked.current) {
      const cx = Math.round(feet.x / SNAP) * SNAP, cz = Math.round(feet.z / SNAP) * SNAP
      const c = current.current
      const moved = !c || c.cx !== cx || c.cz !== cz
      const seated = !devFocus && localSeatId() !== null
      const due = seated ? moved && since.current >= SEATED_REFRESH_S : moved || since.current >= REFRESH_S
      if (due) {
        since.current = 0
        const r = (req.current = (req.current % 1e6) + 1)
        f[gg + 1] = cx
        f[gg + 2] = cz
        f[gg + 3] = SPACING
        f[gg + 4] = SIDE
        f[gg] = r // last: the engine answers when this differs from its last answer
        gridAsked.current = { req: r, cx, cz }
      }
    }
  })

  if (!patch) return null
  // Rapier's heightfield: (rows+1) x (cols+1) heights in column-major order,
  // rows along z and columns along x, the whole thing centred on the collider
  // and `scale` wide.  The engine's sample (ix, iz) is at heights[iz*SIDE+ix],
  // so the collider's element (row iz, column ix) = index ix*SIDE+iz.
  const cells = SIDE - 1
  const hf = new Array<number>(SIDE * SIDE)
  for (let ix = 0; ix < SIDE; ix++) for (let iz = 0; iz < SIDE; iz++) hf[ix * SIDE + iz] = patch.heights[iz * SIDE + ix]
  const span = cells * SPACING
  return (
    <RigidBody key={patch.build} type="fixed" colliders={false} restitution={0} friction={0} position={[patch.cx, 0, patch.cz]}>
      <HeightfieldCollider args={[cells, cells, hf, { x: span, y: 1, z: span }]} />
    </RigidBody>
  )
}
