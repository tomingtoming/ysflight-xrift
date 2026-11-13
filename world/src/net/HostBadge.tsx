/**
 * HostBadge — a small tag above the HUD glass while this browser runs the
 * server (toming, 2026-11-13: the host hardly notices being the host).  The
 * kiosk and the loading panel say it on the ground; this says it in the
 * cockpit, where a stalled host's takeover can also land mid-flight.
 * Drawn over the scene regardless of depth, like the glass.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useRef, useState } from 'react'
import { HUD_H, HUD_W } from '../engine/hudTarget'
import { sessionRole } from './roleStore'
import type { EyeOffset } from './seatEye'

const PX = 0.001
const DIST = 1.4 // the glass's distance (HudGlass)

export function HostBadge({ eye }: { eye: EyeOffset }) {
  const fontFamilies = useDefaultFont(['ja'])
  const [host, setHost] = useState(sessionRole() === 'host')
  const acc = useRef(0)
  useFrame((_s, dt) => {
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    const h = sessionRole() === 'host'
    if (h !== host) setHost(h)
  })
  if (!host) return null
  const glassH = (2 * 0.45 * DIST * HUD_H) / HUD_W
  return (
    <group position={[0, eye.dy + glassH / 2 + 0.035, eye.dz - DIST]}>
      <Container pixelSize={PX} paddingX={16} paddingY={6} borderRadius={10} backgroundColor={0x8a4b00} opacity={0.85}
        depthTest={false} depthWrite={false} renderOrder={1005} fontFamilies={fontFamilies}>
        <Text fontSize={26} color={0xffffff} fontFamily="ja">サーバ（ホスト）</Text>
      </Container>
    </group>
  )
}
