/**
 * SessionPanel — what the original standby dialog offered beyond picking an
 * aircraft, beside the kiosk: who flies, the engine console (join / leave
 * notices, kills, mission announcements), the kill and loss reports, and for
 * the host the missions (intercept, endurance, close air support) and the
 * revival of destroyed ground objects.
 *
 * The buttons queue fsvr.h lobby commands; the engine runs them in any
 * session state, so a host who parked an aircraft can still start a mission.
 * Ending a mission and reviving the ground ask for a second press, as the
 * original dialog did.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useMemo, useRef, useState } from 'react'
import { Group, Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { deliberate } from './clickGuard'
import { gaugeFrame, gaugeLines } from './gauges'
import { publishPanel } from './StateBeacon'
import { NET_CMD, airBase, airCount, airIdentifier, airName, consoleTail, readNetState, requestCommand, type NetState } from './netState'
import type { NetRole } from './NetSession'

const PX = 0.001 // metres per pixel
const W = 1200
const H = 1000
const LOG_LINES = 6
const PILOT_ROWS = 4
const CONFIRM_MS = 4000
const MISSION = ['なし', '迎撃ミッション', '耐久モード', '近接航空支援']

interface Btn { id: string; label: string; cmd: number; confirm?: boolean; host?: boolean }
const REPORTS: Btn[] = [
  { id: 'kills', label: '撃墜記録', cmd: NET_CMD.KILL_REPORT },
  { id: 'losses', label: '被撃墜記録', cmd: NET_CMD.LOSS_REPORT },
]
const MISSIONS: Btn[] = [
  { id: 'intercept', label: '迎撃ミッション', cmd: NET_CMD.INTERCEPT },
  { id: 'cas', label: '近接航空支援', cmd: NET_CMD.CLOSE_AIR_SUPPORT },
  { id: 'endJet', label: '耐久（ジェット）', cmd: NET_CMD.ENDURANCE_JET },
  { id: 'endWw2', label: '耐久（WW2）', cmd: NET_CMD.ENDURANCE_WW2 },
  { id: 'terminate', label: 'ミッション終了', cmd: NET_CMD.TERMINATE_MISSION, confirm: true },
  { id: 'revive', label: '地上物を復活', cmd: NET_CMD.REVIVE_GROUND, confirm: true },
]

export function SessionPanel({ position, yaw = 0, role }: { position: [number, number, number]; yaw?: number; role: NetRole | null }) {
  const mod = useEngine()
  const fontFamilies = useDefaultFont(['ja'])
  const groupRef = useRef<Group>(null)
  const btnRefs = useRef(new Map<string, unknown>())
  const tmp = useRef(new Vector3())
  const [log, setLog] = useState<string[]>([])
  const [pilots, setPilots] = useState<string[]>([])
  const [mission, setMission] = useState(0)
  const [armed, setArmed] = useState<{ id: string; until: number } | null>(null)
  const seq = useRef(-1)
  const netRef = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  const acc = useRef(0)
  const host = role === 'host'
  const [gauge, setGauge] = useState<[string, string, string]>(['', '', ''])

  useFrame((_s, dt) => {
    if (mod && gaugeFrame(mod, dt)) setGauge(gaugeLines())
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    if (!mod) return
    let lines = log
    const s = mod._FsVrConsoleSeq()
    if (s !== seq.current) {
      seq.current = s
      lines = consoleTail(mod, LOG_LINES)
      setLog(lines)
    }
    const f = mod.HEAPF32
    const p: string[] = []
    const n = airCount(mod)
    for (let i = 0; i < n; i++) {
      const b = airBase(mod, i)
      const name = airName(mod, i)
      if (f[b + 1] !== 0 && name) p.push(`${name}  ${airIdentifier(mod, i)}`)
    }
    if (p.length !== pilots.length || p.some((x, i) => x !== pilots[i])) setPilots(p)
    const m = readNetState(mod, netRef.current).mission ?? 0
    if (m !== mission) setMission(m)
    if (armed && performance.now() > armed.until) setArmed(null)
    const buttons: Array<{ name: string; pos: number[] }> = []
    btnRefs.current.forEach((r, name) => {
      const o = r as { getWorldPosition?: (v: Vector3) => Vector3 } | null
      if (o && typeof o.getWorldPosition === 'function') buttons.push({ name, pos: o.getWorldPosition(tmp.current).toArray() })
    })
    publishPanel({ buttons, log: lines })
  })

  const press = (b: Btn) => {
    if (!mod) return
    if (b.confirm && armed?.id !== b.id) {
      setArmed({ id: b.id, until: performance.now() + CONFIRM_MS })
      return
    }
    setArmed(null)
    requestCommand(mod, b.cmd)
  }

  const button = (b: Btn) => {
    const hot = armed?.id === b.id
    return (
      <Container key={b.id} flexGrow={1} flexBasis={0} height={92} flexShrink={0} borderRadius={10} justifyContent="center" alignItems="center"
        backgroundColor={hot ? 0xb5651d : 0x2a3a4a} hover={{ backgroundColor: hot ? 0xd17a26 : 0x3a5068 }}
        cursor="pointer" onClick={(e) => { if (deliberate(e)) press(b) }}
        ref={(r: unknown) => { if (r) btnRefs.current.set(b.id, r); else btnRefs.current.delete(b.id) }}>
        <Text fontSize={34} color={0xffffff} fontFamily="ja">{hot ? 'もう一度押して確定' : b.label}</Text>
      </Container>
    )
  }
  const row = (bs: Btn[]) => <Container flexDirection="row" gap={12} flexShrink={0}>{bs.map(button)}</Container>

  const rot = useMemo<[number, number, number]>(() => [0, yaw, 0], [yaw])
  const shown = pilots.slice(0, PILOT_ROWS)
  return (
    <group ref={groupRef} position={position} rotation={rot}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={20} padding={28}
        flexDirection="column" gap={12} fontFamilies={fontFamilies}>
        <Text fontSize={36} color={0xffffff} fontFamily="ja">{`飛行中 ${pilots.length} 機`}</Text>
        <Container flexDirection="column" height={PILOT_ROWS * 34} flexShrink={0} gap={2}>
          {shown.map((x) => <Text key={x} fontSize={26} color={0xd0d8e0} fontFamily="ja">{x}</Text>)}
          {pilots.length > PILOT_ROWS ? <Text fontSize={22} color={0x8090a0} fontFamily="ja">{`ほか ${pilots.length - PILOT_ROWS} 機`}</Text> : null}
        </Container>
        {row(REPORTS)}
        {host ? (
          <>
            <Text fontSize={28} color={0xa0c8ff} fontFamily="ja">{`ミッション（ホスト）: ${MISSION[mission] ?? 'なし'}`}</Text>
            {row(MISSIONS.slice(0, 2))}
            {row(MISSIONS.slice(2, 4))}
            {row(MISSIONS.slice(4, 6))}
          </>
        ) : (
          <Text fontSize={26} color={0x8090a0} fontFamily="ja">ミッションの開始はホストのパネルから</Text>
        )}
        <Text fontSize={28} color={0xffffff} fontFamily="ja">ログ</Text>
        <Container flexDirection="column" flexGrow={1} backgroundColor={0x06080a} borderRadius={10} padding={12} gap={2} overflow="hidden">
          {log.map((x, i) => <Text key={`${seq.current}-${i}`} fontSize={22} color={0xb8e0b8} fontFamily="ja">{x}</Text>)}
        </Container>
        <Container flexDirection="column" flexShrink={0} gap={2}>
          {gauge.map((x, i) => <Text key={i} fontSize={24} color={0x8090a0} fontFamily="ja">{x}</Text>)}
        </Container>
      </Container>
      <mesh position={[0, -(H * PX) / 2 - 0.55, 0]}>
        <boxGeometry args={[0.25, 1.1, 0.25]} />
        <meshStandardMaterial color="#555" />
      </mesh>
    </group>
  )
}
