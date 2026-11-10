/**
 * StandbyBoard — the engine's original multiplayer standby screen (console,
 * chat log, the standby dialog and its aircraft / start-position choosers)
 * shown as-is on a board beside the kiosk, and operated with the pointer.
 *
 * The engine renders the screen into a texture (engine/menuTarget.ts).  A
 * transparent uikit container lies over it so the host's own interaction
 * (crosshair on PC, touch, controller ray in VR) reaches it the same way it
 * reaches the kiosk; the hit point is turned into the engine's mouse
 * coordinates (pixels from the top-left of the texture).
 */
import { Container } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DoubleSide, Group, Vector3 } from 'three'
import { useEngine, useMenuTexture } from '../engine/engineStore'
import { MENU_H, MENU_W } from '../engine/menuTarget'
import type { YsflightModule } from '../engine/types'
import { setKioskJoin } from './lobbyStore'
import { publishBoard } from './StateBeacon'

const BOARD_W = 2.4
const BOARD_H = (BOARD_W * MENU_H) / MENU_W
const PX = BOARD_W / MENU_W
/** fswindow.h mouse events. */
const EV_LDOWN = 1, EV_LUP = 2, EV_MOVE = 7
/** A click that arrives without its own press: hold the button this long (ms). */
const TAP_HOLD_MS = 120
/** Frames without a fresh engine frame before the board hides (in flight the screen is not drawn). */
const STALE_FRAMES = 30

/** Presses and releases, one engine step apart: the standby dialog samples the button once per step. */
const queue: Array<[number, number, number, number]> = []
let lastX = 0, lastY = 0, held = false
let events = 0
/** Host dialog layout (FsGuiServerDialog, right-aligned in the texture): button centres in texture pixels. */
const HOST_FLY: [number, number] = [MENU_W - 166, 107]
const HOST_CHOOSE_AIR: [number, number] = [MENU_W - 316, 107]

export function boardMouse(ev: number, x: number, y: number): void {
  lastX = x; lastY = y
  if (ev !== EV_MOVE) events++
  if (ev === EV_LDOWN) held = true
  if (ev === EV_LUP) held = false
  queue.push([ev, held ? 1 : 0, x, y])
}
/** A whole click at a texture pixel (dev hook, and hosts that deliver only onClick). */
export function boardTap(x: number, y: number): void {
  boardMouse(EV_MOVE, x, y)
  boardMouse(EV_LDOWN, x, y)
  setTimeout(() => boardMouse(EV_LUP, x, y), TAP_HOLD_MS)
}
/** Frames the button stays down at least: a press and release in one host frame must still read as a click. */
const MIN_HOLD_FRAMES = 6
let sinceDown = MIN_HOLD_FRAMES
const trail: string[] = []
function pump(mod: YsflightModule): void {
  sinceDown++
  const e = queue[0]
  if (!e) return
  if (e[0] === EV_LUP && sinceDown < MIN_HOLD_FRAMES) return
  queue.shift()
  if (e[0] === EV_LDOWN) sinceDown = 0
  if (e[0] !== EV_MOVE) { trail.push(`${e[0] === EV_LDOWN ? 'D' : 'U'}${e[2]},${e[3]}`); if (trail.length > 6) trail.shift() }
  mod._YsfxMouse(e[0], e[1], 0, 0, e[2], e[3])
}

export function StandbyBoard({ position, yaw = 0 }: { position: [number, number, number]; yaw?: number }) {
  const texture = useMenuTexture()
  const mod = useEngine()
  const groupRef = useRef<Group>(null)
  const local = useRef(new Vector3())
  const stale = useRef(STALE_FRAMES)
  const pressed = useRef(false)
  const [shown, setShown] = useState(false)
  const shownRef = useRef(false)

  const toPixel = useCallback((e: unknown): [number, number] | null => {
    const g = groupRef.current
    const pt = (e as { point?: Vector3 }).point
    if (!g || !pt || !shownRef.current) return null
    const l = g.worldToLocal(local.current.copy(pt))
    const x = Math.round((l.x / BOARD_W + 0.5) * MENU_W)
    const y = Math.round((0.5 - l.y / BOARD_H) * MENU_H)
    if (x < 0 || y < 0 || x >= MENU_W || y >= MENU_H) return null
    return [x, y]
  }, [])

  useFrame(() => {
    if (!mod || !texture) return
    pump(mod)
    const p = mod._FsVrMenuDataPointer ? mod._FsVrMenuDataPointer() >> 2 : 0
    if (p && mod.HEAPF32[p + 5] !== 0) { mod.HEAPF32[p + 5] = 0; stale.current = 0 } else stale.current++
    const now = stale.current < STALE_FRAMES
    shownRef.current = now
    if (now !== shown) setShown(now)
    const g = groupRef.current
    if (g) {
      const world = (px: [number, number]) => g.localToWorld(local.current.set((px[0] / MENU_W - 0.5) * BOARD_W, (0.5 - px[1] / MENU_H) * BOARD_H, 0)).toArray()
      publishBoard({ shown: now, fly: world(HOST_FLY), chooseAir: world(HOST_CHOOSE_AIR), events, trail: trail.join(' ') })
    }
  })
  useEffect(() => () => publishBoard(null), [])

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const w = window as unknown as Record<string, unknown>
    w.__ysfxBoardTap = (x: number, y: number) => { setKioskJoin(true); boardTap(x, y); return 'tapped' }
    return () => { delete w.__ysfxBoardTap }
  }, [])

  if (!texture) return null
  return (
    <group ref={groupRef} position={position} rotation={[0, yaw, 0]} visible={shown}>
      <mesh>
        <planeGeometry args={[BOARD_W, BOARD_H]} />
        <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
      </mesh>
      {/* Always mounted: mounting a uikit container later suspends the tree, and the dev
          environment's player restarted at the origin when it did (2026-11-10). */}
      {(
        <group position={[0, 0, 0.004]}>
          <Container sizeX={BOARD_W} sizeY={BOARD_H} pixelSize={PX} backgroundColor={0x000000} opacity={0.01} cursor="pointer"
            onPointerMove={(e) => { const p = toPixel(e); if (p) boardMouse(EV_MOVE, p[0], p[1]) }}
            onPointerDown={(e) => {
              const p = toPixel(e); if (!p) return
              pressed.current = true
              // A 飛行開始 on this board boards the player like the kiosk's does.
              setKioskJoin(true)
              boardMouse(EV_MOVE, p[0], p[1]); boardMouse(EV_LDOWN, p[0], p[1])
            }}
            onPointerUp={(e) => { const p = toPixel(e); pressed.current = false; boardMouse(EV_LUP, p ? p[0] : lastX, p ? p[1] : lastY) }}
            onPointerLeave={() => { if (pressed.current) { pressed.current = false; boardMouse(EV_LUP, lastX, lastY) } }}
            onClick={(e) => {
              // Hosts that deliver a bare click (no press seen): make it a whole tap.
              const p = toPixel(e)
              if (p && !held && queue.length === 0) { setKioskJoin(true); boardTap(p[0], p[1]) }
            }} />
        </group>
      )}
    </group>
  )
}
