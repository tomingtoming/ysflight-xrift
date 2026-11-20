/**
 * PeerLink — trial "peer sky": no server role between browsers.
 *
 * Every browser runs the engine alone (its own -server loop, nobody
 * connected).  This sends the others what this browser owns and hands the
 * engine what they sent (fork: FsVrPeer*).
 *
 * Who owns what (the engine's comment has the full rule):
 *   aircraft        the browser that made them -- its player's, and the ones a
 *                   mission started here generated.  It publishes their states
 *                   and alone decides what a hit does to them.
 *   ground objects  nobody.  Every browser has the field's own; the browser
 *                   whose aircraft hit one says so and all apply the same.
 *
 * Nobody keeps a roster.  An aircraft's type, side and pilot name go out once
 * a second, and whoever arrives late makes the aircraft when it has heard both
 * that and a state.  A newcomer says HELLO; everyone answers with the ground
 * damage they know of (totals, so answers from several add nothing twice) and
 * names their aircraft at once.
 *
 * How often: ten states a second while an aircraft moves or fires, one a
 * second while it stands still.  How big, and the carrier: peerWire.ts,
 * peerRelay.ts.
 *
 * An aircraft goes away on the others when its owner says so (GONE), when the
 * carrier reports the sender left, or when nothing has come for SILENT_MS.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { useEngine } from '../engine/engineStore'
import { openRelay, type PeerCarrier } from './peerRelay'
import {
  MSG_GHIT, MSG_GONE, MSG_GREVIVE, MSG_GTOTALS, MSG_HELLO, MSG_HIT, MSG_IDENT, MSG_STATE,
  decodeGone, decodeGroundHit, decodeGroundTotals, decodeHit, decodeIdent, decodeState,
  encodeGone, encodeGroundHit, encodeGroundTotals, encodeHit, encodeIdent, encodeState,
} from './peerWire'

const SEND_MS = 100
const QUIET_MS = 1000
const IDENT_MS = 1000
const SILENT_MS = 3500

/** What the test beacon reports about the link. */
export const peerStatus = {
  room: null as string | null, open: false, self: 0, sent: 0, got: 0, peers: 0, firstGotAt: 0, hitsOut: 0, hitsIn: 0, hitsDropped: 0,
  /** Aircraft this tab publishes now (its player's and its mission's). */
  owned: 0,
  /** Ground objects of the field: how many, how many dead, damage known in all; hits sent and received. */
  ground: { n: 0, dead: 0, damage: 0, hitsOut: 0, hitsIn: 0 },
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

/** One aircraft of another sender, as its IDENT described it. */
interface Remote { sender: number; gen: number; iff: number; ident: string; name: string; at: number }
/** One aircraft this tab publishes: when its state and its IDENT last went. */
interface Mine { stateAt: number; identAt: number }
const keyOf = (sender: number, gen: number) => `${sender}:${gen}`

export function PeerLink({ relayUrl, room, pilotName }: { relayUrl: string; room: string; pilotName: string }) {
  const mod = useEngine()
  const carrier = useRef<PeerCarrier | null>(null)
  const remotes = useRef(new Map<string, Remote>())
  const mine = useRef(new Map<number, Mine>())
  const self = useRef(0)
  const sendAcc = useRef(SEND_MS)

  useEffect(() => {
    if (!mod || !mod._FsVrPeerOwnCount) return
    const forget = (key: string) => {
      if (remotes.current.delete(key)) mod.ccall('FsVrPeerRemove', null, ['string'], [key])
    }
    const forgetSender = (sender: number) => { for (const [k, r] of [...remotes.current]) if (r.sender === sender) forget(k) }
    const count = (m: Uint8Array) => { peerStatus.out.others++; peerStatus.out.otherBytes += m.length }
    // One connection per engine boot: a restarted engine's clock starts over,
    // and the others must take what it sends as a new sender, not as stale states.
    const c: PeerCarrier = openRelay(relayUrl, room, {
      onOpen: (n) => {
        self.current = n; peerStatus.self = n; peerStatus.open = true
        mine.current.clear() // name everything again
        const hello = new Uint8Array([MSG_HELLO]); c.send(hello); count(hello)
      },
      onLeft: forgetSender,
      onDown: () => {
        peerStatus.open = false
        for (const k of [...remotes.current.keys()]) forget(k) // nothing more will come: do not leave the others frozen in the sky
      },
      onMessage: (sender, msg) => {
        if (msg.length === 0) return
        const now = performance.now()
        switch (msg[0]) {
          case MSG_IDENT: {
            const d = decodeIdent(msg)
            if (d) { const k = keyOf(sender, d.gen); remotes.current.set(k, { sender, ...d, at: remotes.current.get(k)?.at ?? now }) }
            break
          }
          case MSG_STATE: {
            const d = decodeState(msg)
            const k = d ? keyOf(sender, d.gen) : ''
            const r = remotes.current.get(k)
            if (!d || !r) break // its type and name have not come yet (at most a second)
            mod.ccall('FsVrPeerPushState', null, ['string', 'number', 'string', 'string', 'number', 'array', 'number'], [k, d.gen, r.ident, r.name, r.iff, d.packet, d.packet.length])
            r.at = now
            if (peerStatus.got++ === 0) peerStatus.firstGotAt = now
            break
          }
          case MSG_GONE: {
            const gen = decodeGone(msg)
            if (gen !== null) forget(keyOf(sender, gen))
            break
          }
          case MSG_HIT: {
            const d = decodeHit(msg)
            if (!d || d.victim !== self.current) break
            if (DROP_HITS) { peerStatus.hitsDropped++; break }
            // A hit someone else's aircraft scored on one of this browser's: the engine here decides what it does.
            const by = [...remotes.current.values()].find((r) => r.sender === sender && r.name !== '')?.name ?? ''
            mod.ccall('FsVrPeerPushHit', null, ['string', 'number', 'number', 'number'], [by, d.power, d.diedOf, d.gen])
            peerStatus.hitsIn++
            break
          }
          case MSG_GHIT: {
            const d = decodeGroundHit(msg)
            if (d) { mod._FsVrPeerPushGroundHit?.(d.index, d.power); peerStatus.ground.hitsIn++ }
            break
          }
          case MSG_GTOTALS:
            for (const [index, total] of decodeGroundTotals(msg)) mod._FsVrPeerPushGroundTotal?.(index, total)
            break
          case MSG_GREVIVE:
            mod._FsVrPeerPushRevive?.()
            break
          case MSG_HELLO: {
            // A newcomer: what this browser knows of the ground, and its aircraft named now rather than within the second.
            const n = mod._FsVrPeerGroundDamageCount?.() ?? 0
            const dv = new DataView(mod.HEAPU8.buffer)
            const totals: Array<[number, number]> = []
            for (let i = 0; i < n && i < 160; i++) {
              const e = mod._FsVrPeerGroundDamageEntry!(i)
              if (e) totals.push([dv.getInt32(e, true), dv.getInt32(e + 4, true)])
            }
            if (totals.length) { const m = encodeGroundTotals(totals); c.send(m); count(m) }
            for (const v of mine.current.values()) { v.identAt = 0; v.stateAt = 0 }
            break
          }
        }
      },
    }, LAG)
    carrier.current = c
    peerStatus.room = room
    // Dev aid for the tests: send a hit on another sender's unnamed (mission) aircraft
    // as if this tab's weapons had scored it -- aiming a real one from a script is luck.
    const w = window as unknown as { __ysfxPeerTestHit?: (power: number) => string }
    if (import.meta.env.DEV) {
      w.__ysfxPeerTestHit = (power: number) => {
        const r = [...remotes.current.values()].find((q) => q.name === '')
        if (!r) return 'no mission aircraft'
        c.send(encodeHit(r.sender, r.gen, power, 1))
        peerStatus.hitsOut++
        return `${r.sender}:${r.gen}`
      }
    }
    return () => {
      if (import.meta.env.DEV) delete w.__ysfxPeerTestHit
      c.close()
      carrier.current = null
      peerStatus.open = false
      peerStatus.room = null
    }
  }, [mod, relayUrl, room])

  useFrame((_s, dt) => {
    const c = carrier.current
    if (!mod || !mod._FsVrPeerOwnCount || !mod._FsVrPeerOwnEntryPointer || !c || !peerStatus.open) return
    const o = peerStatus.out
    const other = (m: Uint8Array) => { c.send(m); o.others++; o.otherBytes += m.length }
    // Hits and the revival go out the frame they happen (they are events, not states).
    if (mod._FsVrPeerTakeHit) {
      for (let h = mod._FsVrPeerTakeHit(), n = 0; h !== 0 && n < 64; h = mod._FsVrPeerTakeHit(), n++) {
        const dv = new DataView(mod.HEAPU8.buffer)
        other(encodeHit(Number(mod.UTF8ToString(h + 12).split(':')[0]), dv.getInt32(h + 8, true), dv.getInt32(h, true), dv.getInt32(h + 4, true)))
        peerStatus.hitsOut++
      }
    }
    if (mod._FsVrPeerTakeGroundHit) {
      for (let h = mod._FsVrPeerTakeGroundHit(), n = 0; h !== 0 && n < 64; h = mod._FsVrPeerTakeGroundHit(), n++) {
        const dv = new DataView(mod.HEAPU8.buffer)
        other(encodeGroundHit(dv.getInt32(h, true), dv.getInt32(h + 4, true)))
        peerStatus.ground.hitsOut++
      }
    }
    if (mod._FsVrPeerTakeRevive?.()) other(new Uint8Array([MSG_GREVIVE]))

    sendAcc.current += dt * 1000
    if (sendAcc.current < SEND_MS) return
    sendAcc.current = 0
    const now = performance.now()
    for (const [k, r] of [...remotes.current]) if (now - r.at > SILENT_MS) { remotes.current.delete(k); mod.ccall('FsVrPeerRemove', null, ['string'], [k]) }
    peerStatus.peers = mod._FsVrPeerCount?.() ?? 0
    const gs = mod._FsVrPeerGroundStatusPointer?.()
    const view = new DataView(mod.HEAPU8.buffer)
    if (gs) { peerStatus.ground.n = view.getInt32(gs, true); peerStatus.ground.dead = view.getInt32(gs + 4, true); peerStatus.ground.damage = view.getInt32(gs + 8, true) }

    const n = mod._FsVrPeerOwnCount()
    peerStatus.owned = n
    const out = new Set<number>()
    for (let i = 0; i < n; i++) {
      const p = mod._FsVrPeerOwnEntryPointer(i)
      if (!p) continue
      const len = view.getInt32(p, true), gen = view.getInt32(p + 4, true), quiet = view.getInt32(p + 8, true) !== 0
      out.add(gen)
      let m = mine.current.get(gen)
      if (!m) { m = { stateAt: 0, identAt: 0 }; mine.current.set(gen, m) }
      if (now - m.identAt >= IDENT_MS) {
        const player = view.getInt32(p + 16, true) !== 0
        const msg = encodeIdent(gen, view.getInt32(p + 12, true), mod.UTF8ToString(p + 20), player ? pilotName : mod.UTF8ToString(p + 84))
        c.send(msg)
        o.idents++; o.identBytes += msg.length
        m.identAt = now
      }
      if (!quiet || now - m.stateAt >= QUIET_MS) {
        const msg = encodeState(gen, mod.HEAPU8.subarray(p + 116, p + 116 + len))
        c.send(msg)
        o.states++; o.stateBytes += msg.length
        peerStatus.sent++
        m.stateAt = now
      }
    }
    for (const gen of [...mine.current.keys()]) if (!out.has(gen)) { mine.current.delete(gen); other(encodeGone(gen)) }
  })
  return null
}
