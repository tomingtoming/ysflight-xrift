/**
 * peerField — trial "peer sky": which field the sky is, agreed between tabs.
 *
 * In production this is one value in the XRift instance state (NetSession's
 * `net.field`), and nothing here is needed.  The dev environment's tabs share
 * no instance state, so the trial carries the value over a second, tiny relay
 * room (<sky>-s) that outlives the engine: the engine restarts on a new field,
 * and the connection that carries aircraft restarts with it.
 *
 * Anyone may change the field; the change with the highest count wins, the
 * lower sender number breaking a tie.  A newcomer asks and is told.
 *   01 | count u32 | field name (utf-8)     the field is this
 *   02                                      a newcomer asks
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { openRelay, type PeerCarrier } from './peerRelay'

const enc = new TextEncoder()
const dec = new TextDecoder()
/** What the test beacon reports. */
export const peerFieldStatus = { open: false, count: 0, from: 0 }

export function usePeerField(relayUrl: string, sky: string | null): [string | undefined, (field: string) => void] {
  const [field, setFieldState] = useState<string | undefined>(undefined)
  const cur = useRef({ count: 0, from: 0, field: undefined as string | undefined })
  const carrier = useRef<PeerCarrier | null>(null)
  const self = useRef(0)
  const tell = useCallback(() => {
    const c = cur.current
    if (!carrier.current || c.count === 0 || c.field === undefined) return
    const name = enc.encode(c.field)
    const out = new Uint8Array(5 + name.length)
    out[0] = 1
    new DataView(out.buffer).setUint32(1, c.count, true)
    out.set(name, 5)
    carrier.current.send(out)
  }, [])
  useEffect(() => {
    if (!sky) return
    const c = openRelay(relayUrl, `${sky}-s`, {
      onOpen: (n) => { self.current = n; peerFieldStatus.open = true; c.send(new Uint8Array([2])); tell() },
      onLeft: () => {},
      onDown: () => { peerFieldStatus.open = false },
      onMessage: (sender, msg) => {
        if (msg[0] === 2) { tell(); return }
        if (msg[0] !== 1 || msg.length < 6) return
        const count = new DataView(msg.buffer, msg.byteOffset).getUint32(1, true)
        const k = cur.current
        if (count < k.count || (count === k.count && sender >= (k.from || self.current))) return
        cur.current = { count, from: sender, field: dec.decode(msg.subarray(5)) }
        peerFieldStatus.count = count; peerFieldStatus.from = sender
        setFieldState(cur.current.field)
      },
    }, null)
    carrier.current = c
    return () => { c.close(); carrier.current = null; peerFieldStatus.open = false }
  }, [relayUrl, sky, tell])
  const setField = useCallback((f: string) => {
    cur.current = { count: cur.current.count + 1, from: 0, field: f }
    peerFieldStatus.count = cur.current.count; peerFieldStatus.from = 0
    setFieldState(f)
    tell()
  }, [tell])
  return [field, setField]
}
