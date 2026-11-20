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
 *   STATE  01 | gen i32 | engine time (4) | packet from its version field on   (~74 bytes)
 *   IDENT  02 | gen i32 | type length u8, type | name length u8, name          (once a second)
 *   GONE   03                                                                  (the aircraft is no longer out)
 *   HIT    04 | victim sender u16 | victim gen i32 | power i16 | died-of u8    (10 bytes)
 *
 * gen is the owner's search key of the aircraft: a new aircraft is a new gen.
 */
export const MSG_STATE = 1
export const MSG_IDENT = 2
export const MSG_GONE = 3
export const MSG_HIT = 4

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
export function encodeIdent(gen: number, ident: string, name: string): Uint8Array {
  const i = enc.encode(ident).subarray(0, 63), n = enc.encode(name).subarray(0, 63)
  const out = new Uint8Array(7 + i.length + n.length)
  out[0] = MSG_IDENT
  new DataView(out.buffer).setInt32(1, gen, true)
  out[5] = i.length
  out.set(i, 6)
  out[6 + i.length] = n.length
  out.set(n, 7 + i.length)
  return out
}
export function decodeIdent(msg: Uint8Array): { gen: number; ident: string; name: string } | null {
  if (msg.length < 7) return null
  const il = msg[5]
  if (msg.length < 7 + il) return null
  const nl = msg[6 + il]
  if (msg.length < 7 + il + nl) return null
  return { gen: new DataView(msg.buffer, msg.byteOffset).getInt32(1, true), ident: dec.decode(msg.subarray(6, 6 + il)), name: dec.decode(msg.subarray(7 + il, 7 + il + nl)) }
}
export function encodeHit(victim: number, gen: number, power: number, diedOf: number): Uint8Array {
  const out = new Uint8Array(10)
  const v = new DataView(out.buffer)
  out[0] = MSG_HIT
  v.setUint16(1, victim, true)
  v.setInt32(3, gen, true)
  v.setInt16(7, Math.max(-32768, Math.min(32767, power)), true)
  out[9] = diedOf & 255
  return out
}
export function decodeHit(msg: Uint8Array): { victim: number; gen: number; power: number; diedOf: number } | null {
  if (msg.length < 10) return null
  const v = new DataView(msg.buffer, msg.byteOffset)
  return { victim: v.getUint16(1, true), gen: v.getInt32(3, true), power: v.getInt16(7, true), diedOf: msg[9] }
}
