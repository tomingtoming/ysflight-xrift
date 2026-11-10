/**
 * DevHooks — dev-only window hooks so an automated browser can exercise the
 * seat flow without Pointer Lock (which automation cannot grant):
 *   window.__ysfxSit(seatId)   sit the local user on a seat
 *   window.__ysfxStand()       stand up (if the host exposes it)
 *   window.__ysfxLobbyStart(air, stp)  what the kiosk's 飛行開始 does
 *   window.__ysfxSetField(field)  what the host's field pick does
 *   window.__ysfxBodyLag(frames, forceDelay)  the production host's late body (seatLead.ts)
 *   window.__ysfxHud           last HUD lines (set by FlightHud)
 * Compiled out of production bundles (import.meta.env.DEV gate at the call site).
 */
import { useSeatContext } from '@xrift/world-components'
import { useEffect } from 'react'
import { useEngine } from '../engine/engineStore'
import { setKioskJoin, setPendingJoin } from './lobbyStore'
import { NET_FLYING, readNetState, requestJoin, requestLeave, type NetState } from './netState'
import { setDevBodyLag } from './seatLead'

export function DevHooks({ onField }: { onField?: (field: string) => void }) {
  const seat = useSeatContext() as unknown as Record<string, unknown>
  const mod = useEngine()
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    // The production desktop host lands the body one frame late; the dev
    // player lands it at once.  Stand in for that (?bodylag=N, default 1) so
    // the lag measurement and the delayed visuals have something to work on.
    const q = /[?&]bodylag=(\d+)/.exec(location.search)
    setDevBodyLag(q ? Number(q[1]) : 1, /[?&]forcedelay=1/.test(location.search))
    w.__ysfxBodyLag = (frames: number, forceDelay = false, stepHz = 0) => { setDevBodyLag(frames, forceDelay, stepHz); return 'set' }
    w.__ysfxSetField = (f: string) => { if (!onField) return 'not the host'; onField(f); return 'set' }
    w.__ysfxSit = (id: string) => (seat.sit as (id: string) => unknown)(id)
    w.__ysfxStand = () => {
      const f = (seat.standUp ?? seat.leave ?? seat.exit) as ((...a: unknown[]) => unknown) | undefined
      return f ? f() : 'no stand-up API'
    }
    w.__ysfxLobbyStart = (air: string, stp: string) => {
      if (!mod) return 'engine not ready'
      const ns: NetState = { mode: 0, ready: false, state: 0, waiting: false, playerAirId: -1, connected: 0, runState: 0, fatal: 0, rejected: 0 }
      if (readNetState(mod, ns).state === NET_FLYING) {
        // Same as the kiosk: let the parked aircraft go, join from standby.
        setPendingJoin({ air, stp })
        requestLeave(mod)
        return 'replacing'
      }
      setKioskJoin(true)
      requestJoin(mod, air, stp)
      return 'requested'
    }
    return () => {
      delete w.__ysfxLobbyStart
      delete w.__ysfxSit
      delete w.__ysfxStand
      delete w.__ysfxSetField
      delete w.__ysfxBodyLag
    }
  }, [seat, mod, onField])
  return null
}
