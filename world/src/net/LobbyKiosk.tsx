/**
 * LobbyKiosk — the multiplayer standby screen, in the world.
 *
 * A panel on the apron listing every aircraft the engine knows and the
 * field's start positions (both read from the engine once the lobby is
 * ready).  Pick one of each (and the IFF, the team), load the aircraft in the
 * fourth column (weapons, fuel, smoke: the loading tab of the original
 * chooser, whose rules stay in the engine -- loadout.ts) and press 飛行開始: the world asks the engine to
 * join the session; when the aircraft appears the CockpitSeat boards the
 * player automatically.  Interaction goes through uikit's onClick, which the
 * host drives from the crosshair (PC), touch (phone) and the controller ray
 * (VR) alike.
 */
import { Container, Text } from '@react-three/uikit'
import { useFrame } from '@react-three/fiber'
import { useDefaultFont } from '@xrift/world-components'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Vector3 } from 'three'
import { useEngine } from '../engine/engineStore'
import { localSeatId, publishFields, publishKioskButton, publishKioskItems, publishLobby, publishPreview } from './StateBeacon'
import { countKioskClick, noteKioskPointer, pendingJoin, setKioskJoin, setPendingJoin } from './lobbyStore'
import { NET_FLYING, airBase, airCount, lobbyAirNames, lobbyFieldNames, lobbyStpNames, lobbyStpPositions, readNetState, requestJoin, requestLeave, type NetState } from './netState'
import type { NetRole } from './NetSession'
import { deliberate } from './clickGuard'
import { WEAPON_LABEL, loadoutChange, loadoutRevision, loadoutSetAircraft, loadoutSetFuel, loadoutSetSmoke, readLoadout, type Loadout } from './loadout'

const PAGE = 10
const PX = 0.001 // metres per pixel
const W = 2150 // four columns: aircraft, start position, field, loading
const FUEL_STEP = 10
const FUEL_MIN = 10
const H = 1000
/** The panel's centre above the ground (World places it there). */
const KIOSK_CENTRE_M = 1.6
const PREVIEW_CLEAR_M = 0.6
const PREVIEW_GAP_M = 3
const PANEL_HALF_M = (W * PX) / 2
const PREVIEW_TURN_RAD_S = 0.35

export interface LobbyKioskProps {
  position: [number, number, number]
  yaw?: number
  role: NetRole | null
  room: string | null
  defaultAir?: string
  defaultStp?: string
  /** The session's field and, for the host only, how to change it (every engine restarts). */
  field: string
  onField?: (field: string) => void
  /** Unit vectors on the ground (x, z): where the showroom preview stands relative to the panel. */
  previewSide?: [number, number]
  previewAhead?: [number, number]
}


const ptype = (e: unknown) => String((e as { pointerType?: string }).pointerType ?? (e as { nativeEvent?: { pointerType?: string } }).nativeEvent?.pointerType ?? '?')

export function LobbyKiosk({ position, yaw = 0, role, room, defaultAir = 'F-16C_FIGHTINGFALCON', defaultStp = 'RW01_01', field, onField, previewSide = [-1, 0], previewAhead = [0, -1] }: LobbyKioskProps) {
  const mod = useEngine()
  const fontFamilies = useDefaultFont(['ja'])
  const groupRef = useRef<Group>(null)
  const btnWorld = useRef(new Vector3())
  /** uikit items of the field column (uikit components are Object3Ds): their world centres go to the beacon so a harness can click one. */
  const fieldItemRefs = useRef(new Map<string, unknown>())
  const stpItemRefs = useRef(new Map<string, unknown>())
  /** The loading column's buttons, by name (lo+:<FSWEAPONTYPE>, lo-:<type>, fuel+, fuel-, smoke). */
  const loItemRefs = useRef(new Map<string, unknown>())
  const [loadout, setLoadout] = useState<Loadout | null>(null)
  const loRev = useRef(-1)
  const itemWorld = useRef(new Vector3())
  const [airs, setAirs] = useState<string[]>([])
  const [stps, setStps] = useState<string[]>([])
  const [fields, setFields] = useState<string[]>([])
  const [pageFld, setPageFld] = useState(0)
  // A new engine (new field or role) refills the lists.
  useEffect(() => { setAirs([]); setStps([]) }, [mod])
  const [selAir, setSelAir] = useState(defaultAir)
  const [selStp, setSelStp] = useState(defaultStp)
  /** IFF 0..3 (shown as 1..4): the team the aircraft joins as. */
  const [selIff, setSelIff] = useState(0)
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

  const refreshLoadout = useCallback(() => {
    if (!mod) return
    const lo = readLoadout(mod)
    loRev.current = lo.rev
    setLoadout(lo.valid ? lo : null)
  }, [mod])
  // The loading starts over from the template's default whenever another aircraft is picked.
  useEffect(() => {
    if (!mod || airs.length === 0) return
    loadoutSetAircraft(mod, selAir)
    refreshLoadout()
  }, [mod, selAir, airs.length, refreshLoadout])

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
        const fl = lobbyFieldNames(mod)
        setFields(fl)
        publishFields(fl)
        const ia = a.indexOf(selAir)
        setPageAir(ia >= 0 ? Math.floor(ia / PAGE) : 0)
        // Another field has other start positions: fall back to its first one.
        const stp = s.includes(selStp) ? selStp : (s[0] ?? selStp)
        if (stp !== selStp) setSelStp(stp)
        const is = s.indexOf(stp)
        setPageStp(is >= 0 ? Math.floor(is / PAGE) : 0)
        const fi = fl.indexOf(field)
        setPageFld(fi >= 0 ? Math.floor(fi / PAGE) : 0)
      }
    }
    if (groupRef.current) {
      // 飛行開始 button centre (bottom-right of the panel) in world, for the harness.
      btnWorld.current.set((W / 2 - 28 - 160) * PX, -(H / 2 - 28 - 40) * PX, 0)
      publishKioskButton(groupRef.current.localToWorld(btnWorld.current).toArray())
      const items: Array<{ name: string; pos: number[] }> = []
      fieldItemRefs.current.forEach((r, name) => {
        const o = r as { getWorldPosition?: (v: Vector3) => Vector3 } | null
        if (o && typeof o.getWorldPosition === 'function') items.push({ name, pos: o.getWorldPosition(itemWorld.current).toArray() })
      })
      stpItemRefs.current.forEach((r, name) => {
        const o = r as { getWorldPosition?: (v: Vector3) => Vector3 } | null
        if (o && typeof o.getWorldPosition === 'function') items.push({ name, pos: o.getWorldPosition(itemWorld.current).toArray() })
      })
      loItemRefs.current.forEach((r, name) => {
        const o = r as { getWorldPosition?: (v: Vector3) => Vector3 } | null
        if (o && typeof o.getWorldPosition === 'function') items.push({ name, pos: o.getWorldPosition(itemWorld.current).toArray() })
      })
      publishKioskItems(items)
    }
    // The engine changes the loading by itself too (the session's weapon permissions arrive after the lists).
    if (loadoutRevision(mod) !== loRev.current) refreshLoadout()
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
      requestJoin(mod, pj.air, pj.stp, pj.iff ?? -1)
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

  // Showroom preview: the selected aircraft, life-size, turning slowly behind
  // the kiosk (the engine draws it; it is not part of the session).  Hidden
  // while the local player sits in a cockpit.
  useEffect(() => {
    if (!mod || airs.length === 0) return
    mod.ccall('FsVrPreviewSetAircraft', null, ['string'], [selAir])
    return () => { mod.HEAPF32[mod._FsVrPreviewDataPointer() >> 2] = 0 }
  }, [mod, selAir, airs.length])
  const previewPos = useRef(new Vector3())
  const previewTurn = useRef(0)
  useFrame((_s, dt) => {
    if (!mod || !groupRef.current) return
    const p = mod._FsVrPreviewDataPointer() >> 2
    const f = mod.HEAPF32
    const radius = f[p + 5]
    f[p] = airs.length > 0 && localSeatId() === null ? 1 : 0
    previewTurn.current = (previewTurn.current + dt * PREVIEW_TURN_RAD_S) % (Math.PI * 2)
    // Beside the panel, on the visitor's left (the session panel stands on the
    // right), a gap plus its own radius away so the largest airliner clears
    // the kiosk, and lifted with its size so the belly clears the ground.
    const r = radius > 0 ? radius : 10
    const side = PANEL_HALF_M + PREVIEW_GAP_M + r
    previewPos.current.set(
      position[0] + previewSide[0] * side + previewAhead[0] * r * 0.5,
      position[1] - KIOSK_CENTRE_M + PREVIEW_CLEAR_M + r * 0.15,
      position[2] + previewSide[1] * side + previewAhead[1] * r * 0.5)
    f[p + 1] = previewPos.current.x
    f[p + 2] = previewPos.current.y
    f[p + 3] = previewPos.current.z
    f[p + 4] = previewTurn.current
    publishPreview({ air: selAir, pos: previewPos.current.toArray(), radius })
  })

  const start = useCallback(() => {
    countKioskClick()
    if (!mod || !canStart) return
    if (readNetState(mod, netRef.current).state === NET_FLYING) {
      // A parked aircraft still stands: let it go first, join when the engine is back in standby.
      setPendingJoin({ air: selAir, stp: selStp, iff: selIff })
      requestLeave(mod)
      return
    }
    setKioskJoin(true)
    requestJoin(mod, selAir, selStp, selIff)
  }, [mod, canStart, selAir, selStp, selIff])

  const rot = useMemo<[number, number, number]>(() => [0, yaw, 0], [yaw])
  const airPages = Math.max(1, Math.ceil(airs.length / PAGE))
  const stpPages = Math.max(1, Math.ceil(stps.length / PAGE))
  const fldPages = Math.max(1, Math.ceil(fields.length / PAGE))
  const chooseField = useCallback((f: string) => {
    if (!onField || f === field) return
    onField(f) // the host alone: every engine in the session restarts on the new field
  }, [onField, field])

  const loButton = (name: string, label: string, enabled: boolean, press: () => void) => (
    <Container width={56} height={46} borderRadius={8} justifyContent="center" alignItems="center"
      backgroundColor={enabled ? 0x444444 : 0x2a2a2a} hover={{ backgroundColor: enabled ? 0x666666 : 0x2a2a2a }} cursor="pointer"
      onClick={(e) => { if (deliberate(e) && enabled && mod) { press(); refreshLoadout() } }}
      ref={(r: unknown) => { if (r) loItemRefs.current.set(name, r); else loItemRefs.current.delete(name) }}>
      <Text fontSize={30} color={enabled ? 0xffffff : 0x777777}>{label}</Text>
    </Container>
  )
  const loRow = (key: string, label: string, value: string, minus: React.ReactNode, plus: React.ReactNode) => (
    <Container key={key} height={50} paddingX={12} borderRadius={8} backgroundColor={0x222222} flexDirection="row" alignItems="center" justifyContent="space-between">
      <Text fontSize={26} color={0xffffff}>{label}</Text>
      <Container flexDirection="row" alignItems="center" gap={8}>
        {minus}
        <Container width={120} justifyContent="center" alignItems="center"><Text fontSize={26} color={0xffffff}>{value}</Text></Container>
        {plus}
      </Container>
    </Container>
  )
  const loading = (
    <Container flexDirection="column" flexGrow={1} flexBasis={0} gap={6}>
      <Container flexDirection="row" alignItems="center" height={48}>
        <Text fontSize={34} color={0xffffff} fontFamily="ja">兵装 / 燃料</Text>
      </Container>
      {loadout ? (
        <>
          {loadout.slots.filter((sl) => sl.max > 0).map((sl) => loRow(
            `w${sl.type}`, WEAPON_LABEL[sl.type] ?? `#${sl.type}`, `${sl.num}/${sl.max}`,
            loButton(`lo-:${sl.type}`, '-', sl.num > 0, () => loadoutChange(mod!, sl.type, Math.max(0, sl.num - sl.step))),
            loButton(`lo+:${sl.type}`, '+', sl.num < sl.max, () => loadoutChange(mod!, sl.type, Math.min(sl.max, sl.num + sl.step))),
          ))}
          {loRow('fuel', 'FUEL', `${loadout.fuel}%`,
            loButton('fuel-', '-', loadout.fuel > FUEL_MIN, () => loadoutSetFuel(mod!, Math.max(FUEL_MIN, loadout.fuel - FUEL_STEP))),
            loButton('fuel+', '+', loadout.fuel < 100, () => loadoutSetFuel(mod!, Math.min(100, loadout.fuel + FUEL_STEP))))}
          {loadout.smokeGenerators > 0 ? loRow('smoke', 'SMOKE', loadout.smoke ? 'ON' : 'OFF',
            loButton('smoke', loadout.smoke ? 'x' : 'o', true, () => loadoutSetSmoke(mod!, !loadout.smoke)), null) : null}
        </>
      ) : <Text fontSize={26} color={0x888888}>-</Text>}
    </Container>
  )

  const list = (
    title: string, items: string[], page: number, pages: number, sel: string,
    onSel: (v: string) => void, onPage: (p: number) => void, refs?: Map<string, unknown>,
  ) => (
    <Container flexDirection="column" flexGrow={1} flexBasis={0} gap={8}>
      <Container flexDirection="row" alignItems="center" justifyContent="space-between">
        <Text fontSize={34} color={0xffffff} fontFamily="ja">{title}</Text>
        <Container flexDirection="row" alignItems="center" gap={10}>
          <Container width={70} height={48} backgroundColor={0x444444} borderRadius={8} justifyContent="center" alignItems="center"
            hover={{ backgroundColor: 0x666666 }} cursor="pointer" onClick={(e) => { if (deliberate(e)) onPage((page + pages - 1) % pages) }}>
            <Text fontSize={30} color={0xffffff}>{'<'}</Text>
          </Container>
          <Text fontSize={26} color={0xcccccc}>{`${page + 1}/${pages}`}</Text>
          <Container width={70} height={48} backgroundColor={0x444444} borderRadius={8} justifyContent="center" alignItems="center"
            hover={{ backgroundColor: 0x666666 }} cursor="pointer" onClick={(e) => { if (deliberate(e)) onPage((page + 1) % pages) }}>
            <Text fontSize={30} color={0xffffff}>{'>'}</Text>
          </Container>
        </Container>
      </Container>
      {items.slice(page * PAGE, page * PAGE + PAGE).map((name) => (
        <Container key={name} height={56} paddingX={16} justifyContent="center" borderRadius={8}
          backgroundColor={name === sel ? 0x2f6fd0 : 0x222222} hover={{ backgroundColor: name === sel ? 0x3a80e8 : 0x383838 }}
          cursor="pointer" onClick={(e) => { if (deliberate(e)) onSel(name) }}
          ref={refs ? (r: unknown) => { if (r) refs.set(name, r); else refs.delete(name) } : undefined}>
          <Text fontSize={28} color={occupied.has(name) ? 0xff9a7a : 0xffffff} fontFamily="ja">{occupied.has(name) ? `${name}（使用中）` : name}</Text>
        </Container>
      ))}
    </Container>
  )

  return (
    <group ref={groupRef} position={position} rotation={rot}>
      <Container sizeX={W * PX} sizeY={H * PX} pixelSize={PX} backgroundColor={0x101418} borderRadius={20} padding={28}
        flexDirection="column" gap={18} fontFamilies={fontFamilies}>
        <Text fontSize={40} color={0xffffff} fontFamily="ja">{`YSFLIGHT 対戦ロビー - ${field}`}</Text>
        <Text fontSize={28} color={0xa0c8ff} fontFamily="ja">{status}</Text>
        <Container flexDirection="row" gap={28} flexGrow={1}>
          {list('機体', airs, pageAir, airPages, selAir, setSelAir, setPageAir)}
          {list('スタート地点', stps, pageStp, stpPages, selStp, setSelStp, setPageStp, stpItemRefs.current)}
          {list(onField ? 'フィールド（ホスト）' : 'フィールド', fields, pageFld, fldPages, field, chooseField, setPageFld, fieldItemRefs.current)}
          {loading}
        </Container>
        <Container flexDirection="row" alignItems="center" justifyContent="space-between">
          <Text fontSize={30} color={0xffffff} fontFamily="ja">{`選択: ${selAir} / ${selStp}`}</Text>
          <Container flexDirection="row" alignItems="center" gap={10}>
            <Text fontSize={30} color={0xffffff} fontFamily="ja">IFF</Text>
            {[0, 1, 2, 3].map((i) => (
              <Container key={i} width={64} height={64} borderRadius={10} justifyContent="center" alignItems="center"
                backgroundColor={i === selIff ? 0x2f6fd0 : 0x222222} hover={{ backgroundColor: i === selIff ? 0x3a80e8 : 0x383838 }}
                cursor="pointer" onClick={(e) => { if (deliberate(e)) setSelIff(i) }}>
                <Text fontSize={30} color={0xffffff}>{String(i + 1)}</Text>
              </Container>
            ))}
          </Container>
          <Container width={320} height={80} borderRadius={14} justifyContent="center" alignItems="center"
            backgroundColor={canStart ? 0x1f9d55 : 0x444444} hover={{ backgroundColor: canStart ? 0x27b863 : 0x444444 }}
            cursor="pointer" onClick={(e) => { noteKioskPointer('click', ptype(e)); if (deliberate(e)) start() }}
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
