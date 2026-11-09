/**
 * DevHooks — dev-only window hooks so an automated browser can exercise the
 * seat flow without Pointer Lock (which automation cannot grant):
 *   window.__ysfxSit(seatId)   sit the local user on a seat
 *   window.__ysfxStand()       stand up (if the host exposes it)
 *   window.__ysfxLobbyStart(air, stp)  what the kiosk's 飛行開始 does
 *   window.__ysfxHud           last HUD lines (set by FlightHud)
 * Compiled out of production bundles (import.meta.env.DEV gate at the call site).
 */
import { useSeatContext } from '@xrift/world-components'
import { useEffect } from 'react'
import { useEngine } from '../engine/engineStore'
import { setKioskJoin } from './lobbyStore'
import { requestJoin } from './netState'

export function DevHooks() {
  const seat = useSeatContext() as unknown as Record<string, unknown>
  const mod = useEngine()
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__ysfxSit = (id: string) => (seat.sit as (id: string) => unknown)(id)
    w.__ysfxStand = () => {
      const f = (seat.standUp ?? seat.leave ?? seat.exit) as ((...a: unknown[]) => unknown) | undefined
      return f ? f() : 'no stand-up API'
    }
    w.__ysfxLobbyStart = (air: string, stp: string) => {
      if (!mod) return 'engine not ready'
      setKioskJoin(true)
      requestJoin(mod, air, stp)
      return 'requested'
    }
    return () => {
      delete w.__ysfxLobbyStart
      delete w.__ysfxSit
      delete w.__ysfxStand
    }
  }, [seat, mod])
  return null
}
