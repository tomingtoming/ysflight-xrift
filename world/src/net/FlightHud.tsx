/**
 * FlightHud — a small head-up panel ahead of the pilot's eye, fed by the
 * engine's flight-data block (fsvr.h FsVrFlightDataPointer).  The engine's
 * own 2D HUD is not drawn in the host's external-view mode, so this is the
 * cockpit readout: speed, altitude, heading, throttle, gear/brake/flap, weapon.
 */
import { useFrame } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { useDefaultFont } from '@xrift/world-components'
import { useRef, useState } from 'react'
import { useEngine } from '../engine/engineStore'
import { publishHud } from './StateBeacon'

const WEAPON = ['GUN', 'AIM9', 'AGM65', 'BOMB', 'RKT', 'FLARE', 'AIM120', 'B250', 'SMOKE', 'B500', 'AIM9X', 'FLRPOD', 'TANK']

export interface FlightHudProps {
  /** Panel centre relative to the seat (metres). */
  position?: [number, number, number]
  /** false: only compute and publish the lines (beacon), draw nothing -- the HudGlass shows the engine's real HUD. */
  render?: boolean
}

export function FlightHud({ position = [0, 0.7, -1.4], render = true }: FlightHudProps) {
  const mod = useEngine()
  const fonts = useDefaultFont(['ja'])
  const [lines, setLines] = useState<string[]>(['', '', ''])
  const acc = useRef(0)

  useFrame((_s, dt) => {
    if (!mod) return
    acc.current += dt
    if (acc.current < 0.1) return
    acc.current = 0
    const f = mod.HEAPF32
    const d = mod._FsVrFlightDataPointer() >> 2
    if (f[d] === 0) return
    const kmh = Math.round(f[d + 1] * 3.6)
    const alt = Math.round(f[d + 2])
    const hdg = ((Math.round((f[d + 3] * 180) / Math.PI) % 360) + 360) % 360
    const vs = Math.round(f[d + 6])
    const thr = Math.round(f[d + 7] * 100)
    const ab = f[d + 8] !== 0 ? ' AB' : ''
    const s = mod._FsVrAircraftStateDataPointer() >> 2
    const gear = f[s + 1] > 0.5 ? 'GEAR' : ''
    const brk = f[s + 2] > 0.5 ? 'BRK' : ''
    const flp = f[s + 3] > 0.05 ? `FLP${Math.round(f[s + 3] * 100)}` : ''
    const wt = f[s + 4]
    const wpn = wt >= 0 && wt < WEAPON.length ? `${WEAPON[wt]} ${Math.round(f[s + 5])}` : ''
    const next = [
      `SPD ${String(kmh).padStart(4)} km/h   ALT ${String(alt).padStart(5)} m   HDG ${String(hdg).padStart(3, '0')}`,
      `V/S ${String(vs).padStart(4)} m/s   THR ${String(thr).padStart(3)}%${ab}`,
      [gear, brk, flp, wpn].filter(Boolean).join('  '),
    ]
    setLines((prev) => (prev[0] === next[0] && prev[1] === next[1] && prev[2] === next[2] ? prev : next))
    publishHud(next)
  })

  if (!mod) return null
  if (!render) return null
  return (
    <group position={position}>
      <Container
        sizeX={0.9}
        sizeY={0.22}
        pixelSize={0.001}
        backgroundColor={0x000000}
        opacity={0.6}
        borderRadius={12}
        flexDirection="column"
        justifyContent="center"
        alignItems="flex-start"
        paddingX={18}
        gap={4}
        fontFamilies={fonts}
      >
        {lines.map((l, i) => (
          <Text key={i} fontSize={i === 2 ? 30 : 38} color={0x7cff7c} fontFamily="ja">
            {l || ' '}
          </Text>
        ))}
      </Container>
    </group>
  )
}
