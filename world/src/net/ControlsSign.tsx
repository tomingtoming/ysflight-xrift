/**
 * ControlsSign — how to fly, on a board beside the kiosk.
 *
 * Four ways in (keyboard + mouse, gamepad, VR hands, phone) and none of them
 * is discoverable from inside the cockpit.  The board stands left of the
 * kiosk, turned toward the spawn point, and says what each input does.  It
 * is text only: nothing on it can be pressed.
 *
 * The rows are the bindings as implemented -- loadEngine.ts (key table),
 * mouseStick.ts, gamepadStick.ts, vr/saccControls.ts, TouchConsole.tsx.
 * Change a binding there, change the row here.  Glyphs: the host's default
 * font has no arrows or full-width signs (they render as tofu), so plain
 * words and ASCII only -- and no 桿, which it lacks as well.
 */
import { Container, Text } from '@react-three/uikit'
import { useDefaultFont } from '@xrift/world-components'

const PX = 0.001
const W = 2300
const H = 1340
const COL = 1060
const POST_H = 1.6 - (H * PX) / 2 // the board's centre stands 1.6 m above the apron (World.tsx)

type Row = [string, string]
interface Section { title: string; rows: Row[] }

const PC: Section = {
  title: 'PC（キーボードとマウス）',
  rows: [
    ['左ボタンを押してマウス', 'ピッチ / ロール'],
    ['矢印キー', 'ピッチ / ロール'],
    ['Q / A', 'スロットル 上 / 下'],
    ['Tab', 'アフターバーナー'],
    ['Z / X / C', 'ラダー 左 / 中 / 右'],
    ['G / B', '脚 / ブレーキ'],
    ['F / R', 'フラップ 下 / 上'],
    ['2 / 3 / 4', '武器 / レーダー / フレア'],
    ['Space 長押し', '降りる'],
  ],
}
const PAD: Section = {
  title: 'ゲームパッド',
  rows: [
    ['左スティック', 'ピッチ / ロール'],
    ['右スティック 左右', 'ラダー'],
    ['RT / LT', 'スロットル 上 / 下'],
    ['A', '射撃'],
    ['B / X / Y', '武器 / ブレーキ / 脚'],
    ['LB / RB', 'フラップ 上 / 下'],
    ['L3', 'アフターバーナー'],
    ['R3', 'レーダー'],
    ['十字 上 / 下', 'フレア / スモーク'],
  ],
}
const VR: Section = {
  title: 'VR',
  rows: [
    ['右グリップを握る', '手首でピッチ / ロール'],
    ['左グリップを握る', '前後でスロットル'],
    ['グリップ2度握り', '握ったまま固定'],
    ['スティックとトリガー', '機能を選んで実行'],
    ['右 B', 'ブレーキ'],
    ['右 A 長押し', '降りる'],
  ],
}
const PHONE: Section = {
  title: 'スマホ',
  rows: [
    ['スティック', 'ピッチ / ロール'],
    ['HUD下のボタン', 'スロットル・脚・射撃'],
    ['ジャンプ長押し', '降りる'],
  ],
}

function Block({ s }: { s: Section }) {
  return (
    <Container flexDirection="column" gap={6}>
      <Text fontSize={54} color={0xa0c8ff} fontFamily="ja">{s.title}</Text>
      {s.rows.map(([k, v]) => (
        <Container key={k} flexDirection="row" gap={16}>
          <Container width={510}><Text fontSize={44} color={0xffffff} fontFamily="ja">{k}</Text></Container>
          <Text fontSize={44} color={0xc8d0d8} fontFamily="ja">{v}</Text>
        </Container>
      ))}
    </Container>
  )
}

export function ControlsSign({ position, yaw }: { position: [number, number, number]; yaw: number }) {
  const fontFamilies = useDefaultFont(['ja'])
  return (
    <group position={position} rotation={[0, yaw, 0]}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={24} padding={44}
        flexDirection="column" gap={18} fontFamilies={fontFamilies}>
        <Text fontSize={66} color={0xffffff} fontFamily="ja">操作方法</Text>
        <Text fontSize={38} color={0x8a94a0} fontFamily="ja">右のキオスクで機体と開始位置を選んで「飛行開始」。降りた機体には歩いて戻れば乗り直せます。</Text>
        <Container flexDirection="row" gap={40}>
          <Container flexDirection="column" gap={20} width={COL}>
            <Block s={PC} />
            <Block s={PHONE} />
          </Container>
          <Container flexDirection="column" gap={20} width={COL}>
            <Block s={PAD} />
            <Block s={VR} />
          </Container>
        </Container>
      </Container>
      <mesh position={[0, -(H * PX) / 2 - POST_H / 2, 0]}>
        <boxGeometry args={[0.25, POST_H, 0.25]} />
        <meshStandardMaterial color="#555" />
      </mesh>
    </group>
  )
}
