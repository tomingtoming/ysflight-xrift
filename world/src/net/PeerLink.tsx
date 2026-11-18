/**
 * PeerLink — trial "peer sky": no server role between browsers.
 *
 * Every browser runs the engine alone (its own -server loop, nobody
 * connected).  Ten times a second this sends the state of the local player's
 * aircraft to a relay room and hands the engine whatever the others sent
 * (fork: FsVrPeerPushState / FsVrPeerOwnStatePointer).  A message carries the
 * aircraft type and pilot name with the state, so whoever arrives late makes
 * the aircraft from the first message it hears; nobody keeps a roster.
 *
 * An aircraft goes away on the others when its owner says so ('x': landed
 * out, crashed, left the seat), when the relay reports the socket closed
 * ('bye'), or when nothing has come for SILENT_MS.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { useEngine } from '../engine/engineStore'

const SEND_MS = 100
const SILENT_MS = 3000

/** What the test beacon reports about the link. */
export const peerStatus = { room: null as string | null, open: false, sent: 0, got: 0, peers: 0, firstGotAt: 0, hitsOut: 0, hitsIn: 0 }

const b64 = (u: Uint8Array): string => { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s) }
const unb64 = (s: string): Uint8Array => { const r = atob(s); const u = new Uint8Array(r.length); for (let i = 0; i < r.length; i++) u[i] = r.charCodeAt(i); return u }

export function PeerLink({ relayUrl, room, pilotName }: { relayUrl: string; room: string; pilotName: string }) {
  const mod = useEngine()
  // One key per engine boot: a restarted engine's clock starts over, and the
  // others must take what it sends as a new aircraft, not as stale states.
  const key = useMemo(() => `${pilotName}.${Math.random().toString(36).slice(2, 10)}`, [pilotName, mod]) // eslint-disable-line react-hooks/exhaustive-deps
  const ws = useRef<WebSocket | null>(null)
  const seen = useRef(new Map<string, number>())
  const acc = useRef(0)
  const out = useRef(false)

  useEffect(() => {
    if (!mod || !mod._FsVrPeerOwnStatePointer) return
    let closed = false
    let sock: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const drop = () => { for (const k of seen.current.keys()) mod.ccall('FsVrPeerRemove', null, ['string'], [k]); seen.current.clear() }
    const connect = () => {
      sock = new WebSocket(`${relayUrl}?room=${encodeURIComponent(room)}&k=${encodeURIComponent(key)}`)
      ws.current = sock
      sock.onopen = () => { peerStatus.open = true }
      sock.onmessage = (ev) => {
        let m: { t?: string; k?: string; g?: number; i?: string; n?: string; d?: string; v?: string; p?: number; o?: number }
        try { m = JSON.parse(ev.data as string) } catch { return }
        if (!m.k || m.k === key) return
        if (m.t === 's' && m.i && m.n && m.d) {
          const d = unb64(m.d)
          mod.ccall('FsVrPeerPushState', null, ['string', 'number', 'string', 'string', 'array', 'number'], [m.k, m.g ?? 0, m.i, m.n, d, d.length])
          seen.current.set(m.k, performance.now())
          if (peerStatus.got++ === 0) peerStatus.firstGotAt = performance.now()
        } else if (m.t === 'd' && m.v === key) {
          // A hit someone else's weapons scored on this browser's aircraft: the engine here decides what it does.
          mod.ccall('FsVrPeerPushHit', null, ['string', 'number', 'number'], [m.n ?? '', m.p ?? 0, m.o ?? 0])
          peerStatus.hitsIn++
        } else if (m.t === 'x' || m.t === 'bye') {
          // 'bye' names a socket; its aircraft keys are the ones it sent under.
          for (const k of seen.current.keys()) if (k === m.k) { mod.ccall('FsVrPeerRemove', null, ['string'], [k]); seen.current.delete(k) }
        }
      }
      sock.onclose = () => {
        peerStatus.open = false
        drop() // nothing more will come: do not leave the others frozen in the sky
        if (!closed) timer = setTimeout(connect, 2000)
      }
    }
    peerStatus.room = room
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      sock?.close()
      ws.current = null
      peerStatus.open = false
      peerStatus.room = null
    }
  }, [mod, relayUrl, room, key])

  useFrame((_s, dt) => {
    if (!mod || !mod._FsVrPeerOwnStatePointer) return
    // Hits go out the frame they happen (they are events, not states).
    const live = ws.current
    if (live && live.readyState === WebSocket.OPEN && mod._FsVrPeerTakeHit) {
      for (let h = mod._FsVrPeerTakeHit(), n = 0; h !== 0 && n < 64; h = mod._FsVrPeerTakeHit(), n++) {
        const dv = new DataView(mod.HEAPU8.buffer)
        live.send(JSON.stringify({ t: 'd', k: key, v: mod.UTF8ToString(h + 8), p: dv.getInt32(h, true), o: dv.getInt32(h + 4, true), n: pilotName }))
        peerStatus.hitsOut++
      }
    }
    acc.current += dt * 1000
    if (acc.current < SEND_MS) return
    acc.current = 0
    const now = performance.now()
    for (const [k, t] of seen.current) if (now - t > SILENT_MS) { mod.ccall('FsVrPeerRemove', null, ['string'], [k]); seen.current.delete(k) }
    peerStatus.peers = mod._FsVrPeerCount?.() ?? 0
    const sock = ws.current
    if (!sock || sock.readyState !== WebSocket.OPEN) return
    const p = mod._FsVrPeerOwnStatePointer()
    const view = new DataView(mod.HEAPU8.buffer)
    const len = view.getInt32(p, true)
    if (len > 0) {
      const g = view.getInt32(p + 4, true)
      sock.send(JSON.stringify({ t: 's', k: key, g, i: mod.UTF8ToString(p + 8), n: pilotName, d: b64(mod.HEAPU8.subarray(p + 72, p + 72 + len)) }))
      peerStatus.sent++
      out.current = true
    } else if (out.current) {
      sock.send(JSON.stringify({ t: 'x', k: key }))
      out.current = false
    }
  })
  return null
}
