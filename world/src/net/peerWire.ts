/**
 * peerWire — what the "peer sky" trial puts on the wire, in bytes.
 *
 * The carrier (a relay room today; XRift instance events are the other
 * candidate) only has to deliver a byte string to everyone else and say who
 * sent it.  Sizes matter there, and so does how often: a state is the engine's
 * own short aircraft packet minus the two fields its decoder skips, and the
 * aircraft type and pilot name go once a second in a message of their own
 * instead of with every state.
 *
 *   STATE   01 | gen i32 | engine time (4) | packet from its version field on   (an aircraft: 70 bytes)
 *   IDENT   02 | class u8 | gen i32 | iff u8 | type length u8, type | name length u8, name   (once a second per thing)
 *   GONE    03 | class u8 | gen i32                                             (that thing is no longer out)
 *   HIT     04 | victim sender u16 | class u8 | victim gen i32 | power i16 | died-of u8 | shooter gen i32   (15 bytes)
 *   GSTATE  09 | gen i32 | the engine's ground state packet, whole              (a mission's ground unit: ~41 bytes)
 *   LAUNCH  0A | the engine's launch record (52) | launcher class u8, gen i32 |
 *                target kind u8, class u8, owner u16, gen i32                   (a missile, rocket, bomb or flare: 66 bytes)
 *                target kind: 0 none, 1 something the sender owns, 2 something of `owner`, 3 a ground object of the field (gen = its index)
 *   KILL    0B | victim length u8, victim | by length u8, by                    (the owner of what went down says who did it)
 *   SCORES  0C | n u8 | n x (name length u8, name | kills u16 | losses u16)     (for a newcomer)
 *   MISSION 0D | command u8 | seconds left u16                                  (once a second by the browser that runs it; command 0: over)
 *   ALIVE   0E                                                                  (every two seconds: who is in the sky)
 *   GHIT    05 | ground index u16 | power i16                                   (a hit on a ground object of the field)
 *   HELLO   06                                                                  (a newcomer: tell me what stands)
 *   GTOTALS 07 | n x (ground index u16 | damage so far i32)                     (the answer, from everyone who knows any)
 *   GREVIVE 08                                                                  (the ground objects were revived)
 *
 * class: 0 an aircraft, 1 a ground unit.  gen is the owner's search key of the
 * thing: a new one is a new gen, and one sender may have several out (its
 * player's aircraft, and what a mission it started made).
 */
export const MSG_STATE = 1
export const MSG_IDENT = 2
export const MSG_GONE = 3
export const MSG_HIT = 4
export const MSG_GHIT = 5
export const MSG_HELLO = 6
export const MSG_GTOTALS = 7
export const MSG_GREVIVE = 8
export const MSG_GSTATE = 9
export const MSG_LAUNCH = 10
export const MSG_KILL = 11
export const MSG_SCORES = 12
export const MSG_MISSION = 13
export const MSG_ALIVE = 14
export const CLS_AIR = 0
export const CLS_GROUND = 1

const enc = new TextEncoder()
const dec = new TextDecoder()

/** `packet`: the engine's FSNETCMD_AIRPLANESTATE packet (command 4, time 4, id 4, then the state). */
export function encodeState(gen: number, packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 4 + 4 + packet.length - 12)
  out[0] = MSG_STATE
  new DataView(out.buffer).setInt32(1, gen, true)
  out.set(packet.subarray(4, 8), 5)
  out.set(packet.subarray(12), 9)
  return out
}
/** The packet back for the engine: its decoder skips the command and the id, so they stay zero. */
export function decodeState(msg: Uint8Array): { gen: number; packet: Uint8Array } | null {
  if (msg.length < 12) return null
  const packet = new Uint8Array(msg.length - 9 + 12)
  packet.set(msg.subarray(5, 9), 4)
  packet.set(msg.subarray(9), 12)
  return { gen: new DataView(msg.buffer, msg.byteOffset).getInt32(1, true), packet }
}
export function encodeGroundState(gen: number, packet: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + packet.length)
  out[0] = MSG_GSTATE
  new DataView(out.buffer).setInt32(1, gen, true)
  out.set(packet, 5)
  return out
}
export function decodeGroundState(msg: Uint8Array): { gen: number; packet: Uint8Array } | null {
  if (msg.length < 17) return null
  return { gen: new DataView(msg.buffer, msg.byteOffset).getInt32(1, true), packet: msg.slice(5) }
}
export function encodeIdent(cls: number, gen: number, iff: number, ident: string, name: string): Uint8Array {
  const i = enc.encode(ident).subarray(0, 63), n = enc.encode(name).subarray(0, 63)
  const out = new Uint8Array(9 + i.length + n.length)
  out[0] = MSG_IDENT
  out[1] = cls
  new DataView(out.buffer).setInt32(2, gen, true)
  out[6] = iff & 255
  out[7] = i.length
  out.set(i, 8)
  out[8 + i.length] = n.length
  out.set(n, 9 + i.length)
  return out
}
export function decodeIdent(msg: Uint8Array): { cls: number; gen: number; iff: number; ident: string; name: string } | null {
  if (msg.length < 9) return null
  const il = msg[7]
  if (msg.length < 9 + il) return null
  const nl = msg[8 + il]
  if (msg.length < 9 + il + nl) return null
  return { cls: msg[1], gen: new DataView(msg.buffer, msg.byteOffset).getInt32(2, true), iff: msg[6], ident: dec.decode(msg.subarray(8, 8 + il)), name: dec.decode(msg.subarray(9 + il, 9 + il + nl)) }
}
export function encodeGone(cls: number, gen: number): Uint8Array {
  const out = new Uint8Array(6)
  out[0] = MSG_GONE
  out[1] = cls
  new DataView(out.buffer).setInt32(2, gen, true)
  return out
}
export function decodeGone(msg: Uint8Array): { cls: number; gen: number } | null {
  return msg.length < 6 ? null : { cls: msg[1], gen: new DataView(msg.buffer, msg.byteOffset).getInt32(2, true) }
}
export function encodeGroundHit(index: number, power: number): Uint8Array {
  const out = new Uint8Array(5)
  const v = new DataView(out.buffer)
  out[0] = MSG_GHIT
  v.setUint16(1, index, true)
  v.setInt16(3, Math.max(-32768, Math.min(32767, power)), true)
  return out
}
export function decodeGroundHit(msg: Uint8Array): { index: number; power: number } | null {
  if (msg.length < 5) return null
  const v = new DataView(msg.buffer, msg.byteOffset)
  return { index: v.getUint16(1, true), power: v.getInt16(3, true) }
}
export function encodeGroundTotals(totals: Array<[number, number]>): Uint8Array {
  const out = new Uint8Array(1 + totals.length * 6)
  const v = new DataView(out.buffer)
  out[0] = MSG_GTOTALS
  totals.forEach(([index, total], k) => { v.setUint16(1 + k * 6, index, true); v.setInt32(3 + k * 6, total, true) })
  return out
}
export function decodeGroundTotals(msg: Uint8Array): Array<[number, number]> {
  const v = new DataView(msg.buffer, msg.byteOffset)
  const out: Array<[number, number]> = []
  for (let o = 1; o + 6 <= msg.length; o += 6) out.push([v.getUint16(o, true), v.getInt32(o + 2, true)])
  return out
}
export function encodeHit(victim: number, cls: number, gen: number, power: number, diedOf: number, byGen: number): Uint8Array {
  const out = new Uint8Array(15)
  const v = new DataView(out.buffer)
  out[0] = MSG_HIT
  v.setUint16(1, victim, true)
  out[3] = cls
  v.setInt32(4, gen, true)
  v.setInt16(8, Math.max(-32768, Math.min(32767, power)), true)
  out[10] = diedOf & 255
  v.setInt32(11, byGen, true)
  return out
}
export function decodeHit(msg: Uint8Array): { victim: number; cls: number; gen: number; power: number; diedOf: number; byGen: number } | null {
  if (msg.length < 15) return null
  const v = new DataView(msg.buffer, msg.byteOffset)
  return { victim: v.getUint16(1, true), cls: msg[3], gen: v.getInt32(4, true), power: v.getInt16(8, true), diedOf: msg[10], byGen: v.getInt32(11, true) }
}
export interface Launch { raw: Uint8Array; byCls: number; byGen: number; tgtKind: number; tgtCls: number; tgtOwner: number; tgtGen: number }
export function encodeLaunch(l: Launch): Uint8Array {
  const out = new Uint8Array(66)
  const v = new DataView(out.buffer)
  out[0] = MSG_LAUNCH
  out.set(l.raw.subarray(0, 52), 1)
  out[53] = l.byCls
  v.setInt32(54, l.byGen, true)
  out[58] = l.tgtKind
  out[59] = l.tgtCls
  v.setUint16(60, l.tgtOwner, true)
  v.setInt32(62, l.tgtGen, true)
  return out
}
export function decodeLaunch(msg: Uint8Array): Launch | null {
  if (msg.length < 66) return null
  const v = new DataView(msg.buffer, msg.byteOffset)
  return { raw: msg.slice(1, 53), byCls: msg[53], byGen: v.getInt32(54, true), tgtKind: msg[58], tgtCls: msg[59], tgtOwner: v.getUint16(60, true), tgtGen: v.getInt32(62, true) }
}
export function encodeKill(victim: string, by: string): Uint8Array {
  const v = enc.encode(victim).subarray(0, 63), b = enc.encode(by).subarray(0, 63)
  const out = new Uint8Array(3 + v.length + b.length)
  out[0] = MSG_KILL
  out[1] = v.length
  out.set(v, 2)
  out[2 + v.length] = b.length
  out.set(b, 3 + v.length)
  return out
}
export function decodeKill(msg: Uint8Array): { victim: string; by: string } | null {
  if (msg.length < 3) return null
  const vl = msg[1]
  if (msg.length < 3 + vl) return null
  const bl = msg[2 + vl]
  if (msg.length < 3 + vl + bl) return null
  return { victim: dec.decode(msg.subarray(2, 2 + vl)), by: dec.decode(msg.subarray(3 + vl, 3 + vl + bl)) }
}
export type Scores = Record<string, { kills: number; losses: number }>
export function encodeScores(scores: Scores): Uint8Array {
  const rows = Object.entries(scores).slice(0, 40).map(([name, v]) => ({ name: enc.encode(name).subarray(0, 63), v }))
  const out = new Uint8Array(2 + rows.reduce((a, r) => a + 5 + r.name.length, 0))
  const dv = new DataView(out.buffer)
  out[0] = MSG_SCORES
  out[1] = rows.length
  let o = 2
  for (const r of rows) { out[o] = r.name.length; out.set(r.name, o + 1); o += 1 + r.name.length; dv.setUint16(o, r.v.kills, true); dv.setUint16(o + 2, r.v.losses, true); o += 4 }
  return out
}
export function decodeScores(msg: Uint8Array): Scores {
  const dv = new DataView(msg.buffer, msg.byteOffset)
  const out: Scores = {}
  let o = 2
  for (let i = 0; i < (msg[1] ?? 0) && o < msg.length; i++) {
    const l = msg[o]
    if (o + 1 + l + 4 > msg.length) break
    out[dec.decode(msg.subarray(o + 1, o + 1 + l))] = { kills: dv.getUint16(o + 1 + l, true), losses: dv.getUint16(o + 3 + l, true) }
    o += 5 + l
  }
  return out
}
export function encodeMission(cmd: number, seconds: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = MSG_MISSION
  out[1] = cmd
  new DataView(out.buffer).setUint16(2, Math.max(0, Math.min(65535, Math.round(seconds))), true)
  return out
}
export function decodeMission(msg: Uint8Array): { cmd: number; seconds: number } | null {
  return msg.length < 4 ? null : { cmd: msg[1], seconds: new DataView(msg.buffer, msg.byteOffset).getUint16(2, true) }
}
