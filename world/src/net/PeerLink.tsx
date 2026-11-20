/**
 * PeerLink — trial "peer sky": no server role between browsers.
 *
 * Every browser runs the engine alone (its own -server loop, nobody
 * connected).  This sends the state of the local player's aircraft to the
 * others and hands the engine whatever they sent (fork: FsVrPeerPushState /
 * FsVrPeerOwnStatePointer).  Nobody keeps a roster: an aircraft's type and
 * pilot name go out once a second, and whoever arrives late makes the aircraft
 * when it has heard both that and a state.
 *
 * How often: ten states a second while the aircraft moves or fires, one a
 * second while it stands still.  How big, and the carrier: peerWire.ts,
 * peerRelay.ts.
 *
 * An aircraft goes away on the others when its owner says so (GONE: landed
 * out, crashed, left the seat), when the carrier reports the sender left, or
 * when nothing has come for SILENT_MS.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { useEngine } from '../engine/engineStore'
import { openRelay, type PeerCarrier } from './peerRelay'
import { MSG_GONE, MSG_HIT, MSG_IDENT, MSG_STATE, decodeHit, decodeIdent, decodeState, encodeHit, encodeIdent, encodeState } from './peerWire'

const SEND_MS = 100
const QUIET_MS = 1000
const IDENT_MS = 1000
const SILENT_MS = 3500

/** What the test beacon reports about the link. */
export const peerStatus = {
  room: null as string | null, open: false, self: 0, sent: 0, got: 0, peers: 0, firstGotAt: 0, hitsOut: 0, hitsIn: 0, hitsDropped: 0,
  /** Everything this tab has sent: messages and bytes (payload, without the carrier's framing), by kind. */
  out: { states: 0, stateBytes: 0, idents: 0, identBytes: 0, others: 0, otherBytes: 0 },
}

/** Dev aid: ?ysfxnohit=1 throws away the hits aimed at this tab, to tell what its own engine does with the shooter's rounds. */
const DROP_HITS = import.meta.env.DEV && typeof location !== 'undefined' && /[?&]ysfxnohit=1/.test(location.search)
/** Dev aid: ?ysfxlag=<ms>[:<jitter ms>] holds every received message that long (order kept). */
const LAG = (() => {
  const q = import.meta.env.DEV && typeof location !== 'undefined' ? /[?&]ysfxlag=(\d+)(?::(\d+))?/.exec(location.search) : null
  return q ? { ms: Number(q[1]), jitter: Number(q[2] ?? 0) } : null
})()

interface Remote { gen: number; ident: string; name: string; at: number }

export function PeerLink({ relayUrl, room, pilotName }: { relayUrl: string; room: string; pilotName: string }) {
  const mod = useEngine()
  const carrier = useRef<PeerCarrier | null>(null)
  /** Senders heard from: who flies what (from IDENT), and when a state last came. */
  const remotes = useRef(new Map<number, Remote>())
  const self = useRef(0)
  const sendAcc = useRef(SEND_MS)
  const lastState = useRef(0)
  const lastIdent = useRef({ at: 0, gen: -1 })
  const out = useRef(false)

  useEffect(() => {
    if (!mod || !mod._FsVrPeerOwnStatePointer) return
    const forget = (sender: number) => {
      if (remotes.current.delete(sender)) mod.ccall('FsVrPeerRemove', null, ['string'], [String(sender)])
    }
    // One connection per engine boot: a restarted engine's clock starts over,
    // and the others must take what it sends as a new sender, not as stale states.
    const c = openRelay(relayUrl, room, {
      onOpen: (n) => { self.current = n; peerStatus.self = n; peerStatus.open = true; lastIdent.current = { at: 0, gen: -1 } },
      onLeft: forget,
      onDown: () => {
        peerStatus.open = false
        for (const s of [...remotes.current.keys()]) forget(s) // nothing more will come: do not leave the others frozen in the sky
      },
      onMessage: (sender, msg) => {
        if (msg.length === 0) return
        const now = performance.now()
        if (msg[0] === MSG_IDENT) {
          const d = decodeIdent(msg)
          if (d) remotes.current.set(sender, { ...d, at: remotes.current.get(sender)?.at ?? now })
        } else if (msg[0] === MSG_STATE) {
          const d = decodeState(msg)
          const r = remotes.current.get(sender)
          if (!d || !r || r.gen !== d.gen) return // its type and name have not come yet (at most a second)
          mod.ccall('FsVrPeerPushState', null, ['string', 'number', 'string', 'string', 'array', 'number'], [String(sender), d.gen, r.ident, r.name, d.packet, d.packet.length])
          r.at = now
          if (peerStatus.got++ === 0) peerStatus.firstGotAt = now
        } else if (msg[0] === MSG_GONE) {
          forget(sender)
        } else if (msg[0] === MSG_HIT) {
          const d = decodeHit(msg)
          if (!d || d.victim !== self.current) return
          if (DROP_HITS) { peerStatus.hitsDropped++; return }
          // A hit someone else's weapons scored on this browser's aircraft: the engine here decides what it does.
          mod.ccall('FsVrPeerPushHit', null, ['string', 'number', 'number', 'number'], [remotes.current.get(sender)?.name ?? '', d.power, d.diedOf, d.gen])
          peerStatus.hitsIn++
        }
      },
    }, LAG)
    carrier.current = c
    peerStatus.room = room
    return () => {
      c.close()
      carrier.current = null
      peerStatus.open = false
      peerStatus.room = null
    }
  }, [mod, relayUrl, room])

  useFrame((_s, dt) => {
    const c = carrier.current
    if (!mod || !mod._FsVrPeerOwnStatePointer || !c || !peerStatus.open) return
    const o = peerStatus.out
    // Hits go out the frame they happen (they are events, not states).
    if (mod._FsVrPeerTakeHit) {
      for (let h = mod._FsVrPeerTakeHit(), n = 0; h !== 0 && n < 64; h = mod._FsVrPeerTakeHit(), n++) {
        const dv = new DataView(mod.HEAPU8.buffer)
        const m = encodeHit(Number(mod.UTF8ToString(h + 12)), dv.getInt32(h + 8, true), dv.getInt32(h, true), dv.getInt32(h + 4, true))
        c.send(m)
        o.others++; o.otherBytes += m.length
        peerStatus.hitsOut++
      }
    }
    sendAcc.current += dt * 1000
    if (sendAcc.current < SEND_MS) return
    sendAcc.current = 0
    const now = performance.now()
    for (const [s, r] of [...remotes.current]) if (now - r.at > SILENT_MS) { remotes.current.delete(s); mod.ccall('FsVrPeerRemove', null, ['string'], [String(s)]) }
    peerStatus.peers = mod._FsVrPeerCount?.() ?? 0
    const p = mod._FsVrPeerOwnStatePointer()
    const view = new DataView(mod.HEAPU8.buffer)
    const len = view.getInt32(p, true)
    if (len > 0) {
      const gen = view.getInt32(p + 4, true)
      const quiet = view.getInt32(p + 8, true) !== 0
      if (gen !== lastIdent.current.gen || now - lastIdent.current.at >= IDENT_MS) {
        const m = encodeIdent(gen, mod.UTF8ToString(p + 12), pilotName)
        c.send(m)
        o.idents++; o.identBytes += m.length
        lastIdent.current = { at: now, gen }
      }
      if (!quiet || !out.current || now - lastState.current >= QUIET_MS) {
        const m = encodeState(gen, mod.HEAPU8.subarray(p + 76, p + 76 + len))
        c.send(m)
        o.states++; o.stateBytes += m.length
        peerStatus.sent++
        lastState.current = now
      }
      out.current = true
    } else if (out.current) {
      const m = new Uint8Array([MSG_GONE])
      c.send(m)
      o.others++; o.otherBytes += 1
      out.current = false
    }
  })
  return null
}
