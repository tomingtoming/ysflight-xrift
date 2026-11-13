/**
 * LoadingPanel — what a visitor sees while the engine is not flyable yet.
 *
 * The engine brings 27 MB with it and then reads the field; until then the
 * world is a floor in a void and a kiosk that says 準備中.  This panel stands
 * between the spawn and the kiosk, says what is happening and how far it is,
 * and goes away when the field is ready.  It comes back when the host picks
 * another field (the engine restarts).  It also says which role this
 * browser boots in: the role is decided right here (the panel comes back
 * whenever the host seat changes hands), and the host has to know it is one.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useRef, useState } from 'react'
import { useLoad } from '../engine/loadStore'
import { HOST_DUTY, sessionHostName, sessionRole } from './roleStore'

const PX = 0.001
const W = 1500
const H = 760
const BAR_W = W - 160

export function LoadingPanel({ position, yaw, field }: { position: [number, number, number]; yaw: number; field: string }) {
  const fontFamilies = useDefaultFont(['ja'])
  const load = useLoad()
  const [dots, setDots] = useState(0)
  const acc = useRef(0)
  useFrame((_s, dt) => {
    if (load.stage === 'ready') return
    acc.current += dt
    if (acc.current < 0.4) return
    acc.current = 0
    setDots((d) => (d + 1) % 4)
  })
  if (load.stage === 'ready') return null
  // One bar over the three stages: download 0..70 %, boot 70..80 %, field 80..100 %.
  const frac = load.stage === 'download' ? 0.7 * (load.progress ?? 0) : load.stage === 'boot' ? 0.75 : 0.9
  const line = load.stage === 'download'
    ? `エンジンをダウンロード中${load.progress !== null ? ` ${Math.round(load.progress * 100)}%` : ''}`
    : load.stage === 'boot' ? 'エンジンを起動中' : `フィールド ${field} を準備中`
  const role = sessionRole()
  const host = sessionHostName()
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={24} padding={80}
        flexDirection="column" gap={44} justifyContent="center" fontFamilies={fontFamilies}>
        <Text fontSize={96} color={0xffffff} fontFamily="ja">YSFLIGHT</Text>
        <Text fontSize={52} color={0xa0c8ff} fontFamily="ja">{`${line}${'.'.repeat(dots)}`}</Text>
        {role === 'host' ? (
          <Container flexDirection="column" paddingX={24} paddingY={12} borderRadius={14} backgroundColor={0x8a4b00} gap={4}>
            <Text fontSize={42} color={0xffffff} fontFamily="ja">あなたのブラウザがサーバ（ホスト）になりました</Text>
            <Text fontSize={28} color={0xffe2b8} fontFamily="ja">{HOST_DUTY}</Text>
          </Container>
        ) : role === 'client' ? (
          <Text fontSize={36} color={0xc0c8d0} fontFamily="ja">{`サーバ（ホスト）${host ? ` ${host} さん` : ''}に接続します`}</Text>
        ) : null}
        <Container width={BAR_W} height={28} borderRadius={14} backgroundColor={0x2a3340}>
          <Container width={Math.max(28, BAR_W * frac)} height={28} borderRadius={14} backgroundColor={0x4da3ff} />
        </Container>
        <Text fontSize={36} color={0x8a94a0} fontFamily="ja">準備ができるとこの板が消え、奥のキオスクで飛行開始できます</Text>
      </Container>
    </group>
  )
}
