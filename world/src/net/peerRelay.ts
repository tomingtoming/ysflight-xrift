/**
 * peerRelay — the carrier of the "peer sky" trial: a relay room (signal/ /relay).
 *
 * What PeerLink needs from a carrier is this much, so that another one (XRift
 * instance events) can take its place: send bytes to everyone else; receive
 * bytes with a number that names the sender for as long as it stays; hear that
 * a sender left; know this end's own number.
 *
 * The relay numbers each socket and puts that number (u16) in front of what it
 * forwards.  Two control frames come from the relay itself, sender 0:
 *   00 00 | 01 | own number u16      on connect
 *   00 00 | 02 | number u16          that socket closed
 */
export interface PeerCarrier {
  send: (bytes: Uint8Array) => void
  close: () => void
}
export interface PeerCarrierEvents {
  /** Connected (again): this end's number in the room. */
  onOpen: (self: number) => void
  onMessage: (sender: number, bytes: Uint8Array) => void
  onLeft: (sender: number) => void
  /** The connection is down; it is tried again by itself. */
  onDown: () => void
}

export function openRelay(url: string, room: string, ev: PeerCarrierEvents, lag: { ms: number; jitter: number } | null): PeerCarrier {
  let closed = false
  let sock: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const connect = () => {
    const s = new WebSocket(`${url}?room=${encodeURIComponent(room)}`)
    s.binaryType = 'arraybuffer'
    sock = s
    let lastDue = 0
    const receive = (data: unknown) => {
      if (closed || !(data instanceof ArrayBuffer) || data.byteLength < 3) return
      const u = new Uint8Array(data)
      const sender = u[0] | (u[1] << 8)
      if (sender !== 0) { ev.onMessage(sender, u.subarray(2)); return }
      if (u.length < 5) return
      const who = u[3] | (u[4] << 8)
      if (u[2] === 1) ev.onOpen(who)
      else if (u[2] === 2) ev.onLeft(who)
    }
    s.onmessage = lag
      ? (e) => {
          // Dev aid: hold what arrives (order kept), to stand in for a real network.
          const due = Math.max(lastDue, performance.now() + lag.ms + (Math.random() * 2 - 1) * lag.jitter)
          lastDue = due
          setTimeout(() => receive(e.data), due - performance.now())
        }
      : (e) => receive(e.data)
    s.onclose = () => {
      ev.onDown()
      if (!closed) timer = setTimeout(connect, 2000)
    }
  }
  connect()
  return {
    send: (bytes) => { if (sock && sock.readyState === WebSocket.OPEN) sock.send(bytes) },
    close: () => { closed = true; if (timer) clearTimeout(timer); sock?.close() },
  }
}
