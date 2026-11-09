/**
 * LobbyKiosk — the multiplayer standby screen, in the world.
 *
 * A panel on the apron listing every aircraft the engine knows and the
 * field's start positions (both read from the engine once the lobby is
 * ready).  Pick one of each and press 飛行開始: the world asks the engine to
 * join the session; when the aircraft appears the CockpitSeat boards the
 * player automatically.  Interaction goes through uikit's onClick, which the
 * host drives from the crosshair (PC), touch (phone) and the controller ray
 * (VR) alike.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useEngine } from '../engine/engineStore'
import { localSeatId, publishLobby } from './StateBeacon'
import { countKioskClick, noteKioskPointer, pendingJoin, setKioskJoin, setPendingJoin } from './lobbyStore'
import { NET_FLYING, airBase, airCount, lobbyAirNames, lobbyStpNames, lobbyStpPositions, readNetState, requestJoin, requestLeave, type NetState } from './netState'
import type { NetRole } from './NetSession'

const PAGE = 10
const PX = 0.001 // metres per pixel
const W = 1700
const H = 1000

export interface LobbyKioskProps {
  position: [number, number, number]
  yaw?: number
  role: NetRole | null
  room: string | null
  defaultAir?: string
  defaultStp?: string
}

const ptype = (e: unknown) => String((e as { pointerType?: string }).pointerType ?? (e as { nativeEvent?: { pointerType?: string } }).nativeEvent?.pointerType ?? '?')

export function LobbyKiosk({ position, yaw = 0, role, room, defaultAir = 'F-16C_FIGHTINGFALCON', defaultStp = 'RW01_01' }: LobbyKioskProps) {
  const mod = useEngine()
  const fontFamilies = useDefaultFont(['ja'])
  const [airs, setAirs] = useState<string[]>([])
  const [stps, setStps] = useState<string[]>([])
  const [selAir, setSelAir] = useState(defaultAir)
  const [selStp, setSelStp] = useState(defaultStp)
  const [pageAir, setPageAir] = useState(0)
  const [pageStp, setPageStp] = useState(0)
  const [status, setStatus] = useState('エンジン起動中…')
  const [canStart, setCanStart] = useState(false)
  // Start positions an aircraft is standing on: the server rejects a join
  // there ("An airplane is already taking the start position"), so they are
  // marked and the default selection moves to a free one.
  const [occupied, setOccupied] = useState<Set<string>>(new Set())
  const stpPos = useRef<number[][]>([])
  const rejectedSeen = useRef(0)
  const [rejectNote, setRejectNote] = useState('')
  const netRef = useRef<NetState>({ mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 })
  const acc = useRef(0)

  useFrame((_s, dt) => {
    acc.current += dt
    if (acc.current < 0.5) return
    acc.current = 0
    if (!mod) return
    if (airs.length === 0) {
      const a = lobbyAirNames(mod)
      const s = lobbyStpNames(mod)
      if (a.length > 0) {
        setAirs(a)
        setStps(s)
        stpPos.current = lobbyStpPositions(mod)
        publishLobby([a.length, s.length])
        const ia = a.indexOf(selAir)
        setPageAir(ia >= 0 ? Math.floor(ia / PAGE) : 0)
        const is = s.indexOf(selStp)
        setPageStp(is >= 0 ? Math.floor(is / PAGE) : 0)
      }
    }
    const ns = readNetState(mod, netRef.current)
    const seated = localSeatId() !== null
    const who = role === 'host' ? 'サーバ' : role === 'client' ? 'クライアント' : '接続中'
    const st = !ns.ready ? '準備中' : ns.waiting ? '参加承認待ち' : ns.state === NET_FLYING ? (seated ? '飛行中' : '機体を置いて待機（飛行開始で乗り換え）') : '待機'
    setStatus(`${who}  部屋 ${room ?? '-'}  ${st}  接続 ${ns.connected}${rejectNote}`)
    setCanStart(ns.ready && !ns.waiting && (ns.state !== NET_FLYING || !seated))
    const pj = pendingJoin()
    if (pj && ns.ready && !ns.waiting && ns.state !== NET_FLYING) {
      setPendingJoin(null)
      setKioskJoin(true)
      requestJoin(mod, pj.air, pj.stp)
    }
    if (ns.rejected > rejectedSeen.current) {
      rejectedSeen.current = ns.rejected
      setKioskJoin(false)
      setRejectNote('  ※サーバが参加を拒否（スタート地点が使用中か）。別の地点を選んでください')
    }
    // Occupancy: any alive aircraft within 30 m of a start position.
    if (stps.length > 0 && stpPos.current.length === stps.length) {
      const n = airCount(mod)
      const f = mod.HEAPF32
      const occ = new Set<string>()
      for (let i = 0; i < n; i++) {
        const b = airBase(mod, i)
        if (f[b + 1] === 0) continue
        const ax = f[b + 15], az = f[b + 17]
        stpPos.current.forEach((p, k) => {
          if (Math.hypot(p[0] - ax, p[2] - az) < 30) occ.add(stps[k])
        })
      }
      if (occ.size !== occupied.size || [...occ].some((x) => !occupied.has(x))) {
        setOccupied(occ)
        if (occ.has(selStp) && !seated) {
          const free = stps.find((x) => !occ.has(x))
          if (free) {
            setSelStp(free)
            setPageStp(Math.floor(stps.indexOf(free) / PAGE))
          }
        }
      }
    }
  })

  const start = useCallback(() => {
    countKioskClick()
    if (!mod || !canStart) return
    if (readNetState(mod, netRef.current).state === NET_FLYING) {
      // A parked aircraft still stands: let it go first, join when the engine is back in standby.
      setPendingJoin({ air: selAir, stp: selStp })
      requestLeave(mod)
      return
    }
    setKioskJoin(true)
    requestJoin(mod, selAir, selStp)
  }, [mod, canStart, selAir, selStp])

  const rot = useMemo<[number, number, number]>(() => [0, yaw, 0], [yaw])
  const airPages = Math.max(1, Math.ceil(airs.length / PAGE))
  const stpPages = Math.max(1, Math.ceil(stps.length / PAGE))

  const list = (
    title: string, items: string[], page: number, pages: number, sel: string,
    onSel: (v: string) => void, onPage: (p: number) => void,
  ) => (
    <Container flexDirection="column" flexGrow={1} flexBasis={0} gap={8}>
      <Container flexDirection="row" alignItems="center" justifyContent="space-between">
        <Text fontSize={34} color={0xffffff} fontFamily="ja">{title}</Text>
        <Container flexDirection="row" alignItems="center" gap={10}>
          <Container width={70} height={48} backgroundColor={0x444444} borderRadius={8} justifyContent="center" alignItems="center"
            hover={{ backgroundColor: 0x666666 }} cursor="pointer" onClick={() => onPage((page + pages - 1) % pages)}>
            <Text fontSize={30} color={0xffffff}>◀</Text>
          </Container>
          <Text fontSize={26} color={0xcccccc}>{`${page + 1}/${pages}`}</Text>
          <Container width={70} height={48} backgroundColor={0x444444} borderRadius={8} justifyContent="center" alignItems="center"
            hover={{ backgroundColor: 0x666666 }} cursor="pointer" onClick={() => onPage((page + 1) % pages)}>
            <Text fontSize={30} color={0xffffff}>▶</Text>
          </Container>
        </Container>
      </Container>
      {items.slice(page * PAGE, page * PAGE + PAGE).map((name) => (
        <Container key={name} height={56} paddingX={16} justifyContent="center" borderRadius={8}
          backgroundColor={name === sel ? 0x2f6fd0 : 0x222222} hover={{ backgroundColor: name === sel ? 0x3a80e8 : 0x383838 }}
          cursor="pointer" onClick={() => onSel(name)}>
          <Text fontSize={28} color={occupied.has(name) ? 0xff9a7a : 0xffffff} fontFamily="ja">{occupied.has(name) ? `${name}（使用中）` : name}</Text>
        </Container>
      ))}
    </Container>
  )

  return (
    <group position={position} rotation={rot}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={20} padding={28}
        flexDirection="column" gap={18} fontFamilies={fontFamilies}>
        <Text fontSize={40} color={0xffffff} fontFamily="ja">YSFLIGHT 対戦ロビー</Text>
        <Text fontSize={28} color={0xa0c8ff} fontFamily="ja">{status}</Text>
        <Container flexDirection="row" gap={28} flexGrow={1}>
          {list('機体', airs, pageAir, airPages, selAir, setSelAir, setPageAir)}
          {list('スタート地点', stps, pageStp, stpPages, selStp, setSelStp, setPageStp)}
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={30} color={0xffffff} fontFamily="ja">{`選択: ${selAir} / ${selStp}`}</Text>
          <Container width={320} height={80} borderRadius={14} justifyContent="center" alignItems="center"
            backgroundColor={canStart ? 0x1f9d55 : 0x444444} hover={{ backgroundColor: canStart ? 0x27b863 : 0x444444 }}
            cursor="pointer" onClick={(e) => { noteKioskPointer('click', ptype(e)); start() }}
            onPointerEnter={(e) => noteKioskPointer('enter', ptype(e))} onPointerLeave={(e) => noteKioskPointer('leave', ptype(e))}
            onPointerDown={(e) => noteKioskPointer('down', ptype(e))} onPointerUp={(e) => noteKioskPointer('up', ptype(e))}>
            <Text fontSize={36} color={0xffffff} fontFamily="ja">飛行開始</Text>
          </Container>
        </Container>
      </Container>
      {/* stand: from the ground up to the panel's bottom edge */}
      <mesh position={[0, -(H * PX) / 2 - 0.55, 0]}>
        <boxGeometry args={[0.25, 1.1, 0.25]} />
        <meshStandardMaterial color="#555" />
      </mesh>
    </group>
  )
}
