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
