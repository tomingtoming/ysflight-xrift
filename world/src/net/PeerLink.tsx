/**
 * PeerLink — trial "peer sky": no server role between browsers.
 *
 * Every browser runs the engine alone (its own -server loop, nobody
 * connected).  This sends the others what this browser owns and hands the
 * engine what they sent (fork: FsVrPeer*).
 *
 * Who owns what (the engine's comment has the full rule):
 *   aircraft, and   the browser that made them -- its player's aircraft, and the
 *   a mission's     aircraft and ground units a mission started here generated.
 *   ground units    It publishes their states and alone decides what a hit does
 *                   to them.
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
 *
 * Missions.  The browser that starts one runs it and is its referee: it says
 * once a second which mission and how long is left, and that is what the
 * others show.  One mission to a sky: if two run, the browser with the lower
 * number keeps its own and the other ends its.  If the browser that runs the
 * mission leaves, the lowest-numbered one still there starts it again with the
 * time that was left (the mission's aircraft and units are made anew).
 *
 * Score.  When something goes down to another browser's hit, its owner says
 * who did it (KILL); every browser counts the same lines, and a newcomer is
 * handed the count.
 */
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { useEngine } from '../engine/engineStore'
import { openRelay, type PeerCarrier } from './peerRelay'
import { NET_CMD, requestCommand } from './netState'
import {
  CLS_AIR, CLS_GROUND, MSG_GHIT, MSG_GONE, MSG_GREVIVE, MSG_GSTATE, MSG_GTOTALS, MSG_HELLO, MSG_HIT, MSG_IDENT, MSG_LAUNCH, MSG_STATE,
  MSG_ALIVE, MSG_KILL, MSG_MISSION, MSG_SCORES, type Scores,
  decodeKill, decodeLaunch, decodeMission, decodeScores, encodeKill, encodeLaunch, encodeMission, encodeScores,
  decodeGone, decodeGroundHit, decodeGroundState, decodeGroundTotals, decodeHit, decodeIdent, decodeState,
  encodeGone, encodeGroundHit, encodeGroundState, encodeGroundTotals, encodeHit, encodeIdent, encodeState,
} from './peerWire'

const SEND_MS = 100
const QUIET_MS = 1000
const IDENT_MS = 1000
const SILENT_MS = 3500
const MISSION_MS = 1000
const ALIVE_MS = 2000
const ROSTER_MS = 5000

/** What the test beacon reports about the link. */
export const peerStatus = {
  room: null as string | null, open: false, self: 0, sent: 0, got: 0, peers: 0, firstGotAt: 0, hitsOut: 0, hitsIn: 0, hitsDropped: 0,
  /** What this tab publishes now (its player's aircraft, its mission's aircraft and ground units), and what did not fit the engine's list. */
  owned: 0, ownedGround: 0, ownedDropped: 0,
  /** Copies here of other tabs' ground units. */
  groundCopies: 0,
  /** Weapons launched (missiles, rockets, bombs, flares): told to the others, heard from them, and replayed by the engine here. */
  launches: { out: 0, in: 0, shown: 0 },
  /** Dev: where the ground units this tab owns are, and where its copies of the others' are (up to 8 each). */
  groundPos: { owned: [] as number[][], copies: [] as number[][] },
  /** Ground objects of the field: how many, how many dead, damage known in all; hits sent and received. */
  ground: { n: 0, dead: 0, damage: 0, hitsOut: 0, hitsIn: 0 },
  /** The sky as everyone should see it: the mission that runs (command, seconds left, whose: 0 = this tab's), the score, who is here. */
  sky: { mission: null as null | { cmd: number; seconds: number; owner: number }, scores: {} as Scores, roster: [] as number[], yielded: 0, adopted: 0, kills: 0 },
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

/** One thing of another sender (an aircraft or a ground unit), as its IDENT described it. */
interface Remote { sender: number; cls: number; gen: number; iff: number; ident: string; name: string; at: number }
/** One thing this tab publishes: when its state and its IDENT last went. */
interface Mine { cls: number; gen: number; stateAt: number; identAt: number }
const keyOf = (sender: number, cls: number, gen: number) => `${sender}:${cls === CLS_GROUND ? 'g' : ''}${gen}`

export function PeerLink({ relayUrl, room, pilotName }: { relayUrl: string; room: string; pilotName: string }) {
  const mod = useEngine()
  const carrier = useRef<PeerCarrier | null>(null)
  const remotes = useRef(new Map<string, Remote>())
  const mine = useRef(new Map<string, Mine>())
  const self = useRef(0)
  const handOverRef = useRef<() => void>(() => {})
  const sendAcc = useRef(SEND_MS)
  /** Senders heard from lately, and the mission another of them runs. */
  const roster = useRef(new Map<number, number>())
  const theirs = useRef<null | { sender: number; cmd: number; seconds: number; at: number }>(null)
  const missionAt = useRef(0)
  const aliveAt = useRef(0)
  const myCmdWas = useRef(0)
  const tally = (victim: string, by: string) => {
    const sc = peerStatus.sky.scores
    if (by) (sc[by] ??= { kills: 0, losses: 0 }).kills++
    if (victim) (sc[victim] ??= { kills: 0, losses: 0 }).losses++
    peerStatus.sky.kills++
  }

  useEffect(() => {
    if (!mod || !mod._FsVrPeerOwnCount) return
    const forget = (key: string) => {
      const r = remotes.current.get(key)
      if (r && remotes.current.delete(key)) mod.ccall('FsVrPeerRemove', null, ['string', 'number'], [key, r.cls])
    }
    const forgetSender = (sender: number) => { for (const [k, r] of [...remotes.current]) if (r.sender === sender) forget(k) }
    // The browser that ran the mission is gone without ending it: the lowest number still here takes it over.
    const handOver = () => {
      const m = theirs.current
      theirs.current = null
      if (!m || m.cmd === 0) return
      const now = performance.now()
      const here = [...roster.current].filter(([s, at]) => s !== m.sender && now - at < ROSTER_MS).map(([s]) => s)
      if (here.some((s) => s < self.current)) return
      mod.ccall('FsVrPeerMissionAdopt', null, ['number', 'number'], [m.cmd, Math.max(0, m.seconds - (now - m.at) / 1000)])
      peerStatus.sky.adopted++
    }
    handOverRef.current = handOver
    const count = (m: Uint8Array) => { peerStatus.out.others++; peerStatus.out.otherBytes += m.length }
    // One connection per engine boot: a restarted engine's clock starts over,
    // and the others must take what it sends as a new sender, not as stale states.
    const c: PeerCarrier = openRelay(relayUrl, room, {
      onOpen: (n) => {
        self.current = n; peerStatus.self = n; peerStatus.open = true
        mine.current.clear() // name everything again
        roster.current.clear(); theirs.current = null; missionAt.current = 0
        const hello = new Uint8Array([MSG_HELLO]); c.send(hello); count(hello)
      },
      onLeft: (sender) => {
        roster.current.delete(sender)
        forgetSender(sender)
        if (theirs.current?.sender === sender) handOver()
      },
      onDown: () => {
        peerStatus.open = false
        for (const k of [...remotes.current.keys()]) forget(k) // nothing more will come: do not leave the others frozen in the sky
      },
      onMessage: (sender, msg) => {
        if (msg.length === 0) return
        const now = performance.now()
        roster.current.set(sender, now)
        switch (msg[0]) {
          case MSG_ALIVE:
            break
          case MSG_MISSION: {
            const d = decodeMission(msg)
            if (!d) break
            if (d.cmd === 0) { if (theirs.current?.sender === sender) theirs.current = null; break }
            // Two browsers may say so at once: the lower number's is the sky's.
            if (!theirs.current || sender <= theirs.current.sender) theirs.current = { sender, cmd: d.cmd, seconds: d.seconds, at: now }
            break
          }
          case MSG_KILL: {
            const d = decodeKill(msg)
            if (!d) break
            tally(d.victim, d.by)
            mod.ccall('FsVrPeerSay', null, ['string'], [`${d.by || '?'} shot down ${d.victim}`])
            break
          }
          case MSG_SCORES: {
            // A newcomer's catch-up, from everyone: the same lines counted everywhere, so the larger number is the fuller one.
            const sc = peerStatus.sky.scores
            for (const [name, v] of Object.entries(decodeScores(msg))) {
              const mineRow = (sc[name] ??= { kills: 0, losses: 0 })
              mineRow.kills = Math.max(mineRow.kills, v.kills); mineRow.losses = Math.max(mineRow.losses, v.losses)
            }
            break
          }
          case MSG_IDENT: {
            const d = decodeIdent(msg)
            if (d) { const k = keyOf(sender, d.cls, d.gen); remotes.current.set(k, { sender, ...d, at: remotes.current.get(k)?.at ?? now }) }
            break
          }
          case MSG_STATE:
          case MSG_GSTATE: {
            const cls = msg[0] === MSG_STATE ? CLS_AIR : CLS_GROUND
            const d = cls === CLS_AIR ? decodeState(msg) : decodeGroundState(msg)
            const k = d ? keyOf(sender, cls, d.gen) : ''
            const r = remotes.current.get(k)
            if (!d || !r) break // its type and name have not come yet (at most a second)
            mod.ccall('FsVrPeerPushState', null, ['string', 'number', 'number', 'string', 'string', 'number', 'array', 'number'], [k, cls, d.gen, r.ident, r.name, r.iff, d.packet, d.packet.length])
            r.at = now
            if (peerStatus.got++ === 0) peerStatus.firstGotAt = now
            break
          }
          case MSG_GONE: {
            const d = decodeGone(msg)
            if (d) forget(keyOf(sender, d.cls, d.gen))
            break
          }
          case MSG_HIT: {
            const d = decodeHit(msg)
            if (!d || d.victim !== self.current) break
            if (DROP_HITS) { peerStatus.hitsDropped++; break }
            // A hit something of another sender's scored on something this browser owns: the engine here decides what it does.
            const shooter = remotes.current.get(keyOf(sender, CLS_AIR, d.byGen)) ?? remotes.current.get(keyOf(sender, CLS_GROUND, d.byGen))
            mod.ccall('FsVrPeerPushHit', null, ['string', 'number', 'number', 'number', 'number'], [shooter ? (shooter.name || shooter.ident) : '', d.cls, d.power, d.diedOf, d.gen])
            peerStatus.hitsIn++
            break
          }
          case MSG_LAUNCH: {
            // Shown here, decides nothing: what it hits is told by the browser that launched it.
            const d = decodeLaunch(msg)
            if (!d) break
            let kind = d.tgtKind, key = ''
            if (d.tgtKind === 1) { kind = 2; key = keyOf(sender, d.tgtCls, d.tgtGen) } // the sender's own thing is a copy here
            else if (d.tgtKind === 2) { if (d.tgtOwner === self.current) kind = 1; else key = keyOf(d.tgtOwner, d.tgtCls, d.tgtGen) }
            mod.ccall('FsVrPeerPushLaunch', null, ['array', 'string', 'number', 'number', 'number', 'number', 'string'], [d.raw, keyOf(sender, d.byCls, d.byGen), d.byCls, kind, d.tgtCls, d.tgtGen, key])
            peerStatus.launches.in++
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
            if (Object.keys(peerStatus.sky.scores).length) { const m = encodeScores(peerStatus.sky.scores); c.send(m); count(m) }
            missionAt.current = 0 // say the mission now
            break
          }
        }
      },
    }, LAG)
    carrier.current = c
    peerStatus.room = room
    mod.ccall('FsVrPeerEnable', null, ['number'], [1])
    // Dev aid for the tests: send a hit on another sender's unnamed (mission) aircraft
    // as if this tab's weapons had scored it -- aiming a real one from a script is luck.
    const w = window as unknown as { __ysfxPeerTestHit?: (power: number) => string }
    if (import.meta.env.DEV) {
      w.__ysfxPeerTestHit = (power: number) => {
        const r = [...remotes.current.values()].find((q) => q.name === '' && q.cls === CLS_AIR)
        if (!r) return 'no mission aircraft'
        c.send(encodeHit(r.sender, r.cls, r.gen, power, 1, -1))
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
        other(encodeHit(Number(mod.UTF8ToString(h + 20).split(':')[0]), dv.getInt32(h + 12, true), dv.getInt32(h + 8, true), dv.getInt32(h, true), dv.getInt32(h + 4, true), dv.getInt32(h + 16, true)))
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
    if (mod._FsVrPeerTakeKill) {
      for (let h = mod._FsVrPeerTakeKill(), n = 0; h !== 0 && n < 16; h = mod._FsVrPeerTakeKill(), n++) {
        const victim = mod.UTF8ToString(h + 8), by = mod.UTF8ToString(h + 72)
        other(encodeKill(victim, by))
        tally(victim, by)
        // The engine has already told the pilot of its own aircraft; anything else it owns gets the line here.
        if (victim !== pilotName) mod.ccall('FsVrPeerSay', null, ['string'], [`${by || '?'} shot down ${victim}`])
      }
    }
    if (mod._FsVrPeerTakeLaunch) {
      for (let h = mod._FsVrPeerTakeLaunch(), n = 0; h !== 0 && n < 64; h = mod._FsVrPeerTakeLaunch(), n++) {
        const dv = new DataView(mod.HEAPU8.buffer)
        const tgtKind = dv.getInt32(h + 60, true)
        other(encodeLaunch({ raw: mod.HEAPU8.slice(h, h + 52), byCls: dv.getInt32(h + 52, true), byGen: dv.getInt32(h + 56, true), tgtKind, tgtCls: dv.getInt32(h + 64, true), tgtOwner: tgtKind === 2 ? Number(mod.UTF8ToString(h + 72).split(':')[0]) : 0, tgtGen: dv.getInt32(h + 68, true) }))
        peerStatus.launches.out++
      }
    }

    sendAcc.current += dt * 1000
    if (sendAcc.current < SEND_MS) return
    sendAcc.current = 0
    const now = performance.now()
    for (const [k, r] of [...remotes.current]) if (now - r.at > SILENT_MS) { remotes.current.delete(k); mod.ccall('FsVrPeerRemove', null, ['string', 'number'], [k, r.cls]) }
    peerStatus.groundCopies = mod._FsVrPeerGroundCopyCount?.() ?? 0
    peerStatus.ownedDropped = mod._FsVrPeerOwnDropped?.() ?? 0
    peerStatus.launches.shown = mod._FsVrPeerLaunchShown?.() ?? 0
    if (import.meta.env.DEV && mod._FsVrPeerDebugGroundPos) {
      for (const [which, into] of [[0, 'owned'], [1, 'copies']] as const) {
        const list: number[][] = []
        for (let i = 0; i < 8; i++) { const q = mod._FsVrPeerDebugGroundPos(which, i); if (!q) break; list.push([mod.HEAPF32[q >> 2], mod.HEAPF32[(q >> 2) + 1], mod.HEAPF32[(q >> 2) + 2]]) }
        peerStatus.groundPos[into] = list
      }
    }
    peerStatus.peers = mod._FsVrPeerCount?.() ?? 0
    const gs = mod._FsVrPeerGroundStatusPointer?.()
    const view = new DataView(mod.HEAPU8.buffer)
    if (gs) { peerStatus.ground.n = view.getInt32(gs, true); peerStatus.ground.dead = view.getInt32(gs + 4, true); peerStatus.ground.damage = view.getInt32(gs + 8, true) }

    // Who is here; the mission (this tab's, or the one another runs); who yields when two run.
    if (now - aliveAt.current >= ALIVE_MS) { aliveAt.current = now; other(new Uint8Array([MSG_ALIVE])) }
    for (const [s, at] of [...roster.current]) if (now - at > ROSTER_MS) roster.current.delete(s)
    peerStatus.sky.roster = [...roster.current.keys()].sort((a, b) => a - b)
    if (theirs.current && now - theirs.current.at > SILENT_MS) handOverRef.current()
    const mp = mod._FsVrPeerMissionPointer?.()
    const myCmd = mp ? mod.HEAPF32[mp >> 2] : 0, mySec = mp ? mod.HEAPF32[(mp >> 2) + 1] : 0
    if (now - missionAt.current >= MISSION_MS || (myCmd === 0) !== (myCmdWas.current === 0)) {
      missionAt.current = now
      if (myCmd !== 0) {
        other(encodeMission(myCmd, mySec))
        if (theirs.current && theirs.current.sender < self.current) { requestCommand(mod, NET_CMD.TERMINATE_MISSION); peerStatus.sky.yielded++ }
      } else if (myCmdWas.current !== 0) other(encodeMission(0, 0))
      myCmdWas.current = myCmd
    }
    const t = theirs.current
    peerStatus.sky.mission = myCmd !== 0 && !(t && t.sender < self.current) ? { cmd: myCmd, seconds: Math.round(mySec), owner: 0 }
      : t ? { cmd: t.cmd, seconds: Math.max(0, Math.round(t.seconds - (now - t.at) / 1000)), owner: t.sender } : null

    const n = mod._FsVrPeerOwnCount()
    peerStatus.owned = n
    let grounds = 0
    const out = new Set<string>()
    for (let i = 0; i < n; i++) {
      const p = mod._FsVrPeerOwnEntryPointer(i)
      if (!p) continue
      const len = view.getInt32(p, true), gen = view.getInt32(p + 4, true), quiet = view.getInt32(p + 8, true) !== 0, cls = view.getInt32(p + 20, true)
      if (cls === CLS_GROUND) grounds++
      const id = `${cls}:${gen}`
      out.add(id)
      let m = mine.current.get(id)
      if (!m) { m = { cls, gen, stateAt: 0, identAt: 0 }; mine.current.set(id, m) }
      if (now - m.identAt >= IDENT_MS) {
        const player = view.getInt32(p + 16, true) !== 0
        const msg = encodeIdent(cls, gen, view.getInt32(p + 12, true), mod.UTF8ToString(p + 24), player ? pilotName : mod.UTF8ToString(p + 88))
        c.send(msg)
        o.idents++; o.identBytes += msg.length
        m.identAt = now
      }
      if (!quiet || now - m.stateAt >= QUIET_MS) {
        const pkt = mod.HEAPU8.subarray(p + 120, p + 120 + len)
        const msg = cls === CLS_AIR ? encodeState(gen, pkt) : encodeGroundState(gen, pkt)
        c.send(msg)
        o.states++; o.stateBytes += msg.length
        peerStatus.sent++
        m.stateAt = now
      }
    }
    peerStatus.ownedGround = grounds
    for (const [id, m] of [...mine.current]) if (!out.has(id)) { mine.current.delete(id); other(encodeGone(m.cls, m.gen)) }
  })
  return null
}
