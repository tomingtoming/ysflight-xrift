/**
 * DevHooks — dev-only window hooks so an automated browser can exercise the
 * seat flow without Pointer Lock (which automation cannot grant):
 *   window.__ysfxSit(seatId)   sit the local user on a seat
 *   window.__ysfxStand()       stand up (if the host exposes it)
 *   window.__ysfxLobbyStart(air, stp)  what the kiosk's 飛行開始 does
 *   window.__ysfxSetField(field)  what the host's field pick does
 *   window.__ysfxPatchFocus(x, z)  lay the ground patch around a point instead of the player (null args: back to the player)
 *   window.__ysfxApronAt(x, y, z)  move the apron -- and with its spawn point the dev player, who follows it;
 *                              the host's teleport does nothing here (tests walk on slopes far from the airfield)
 *   window.__ysfxGroundRay(x, z)   height of the highest collider under a point (a physics ray straight down)
 *   window.__ysfxLoadout(air, changes, fuel, smoke)  what the kiosk's loading column does: start from
 *                              the template's default, apply [FSWEAPONTYPE, n] pairs, set fuel % / smoke
 *   window.__ysfxBodyLag(frames, forceDelay)  the production host's late body (seatLead.ts)
 *   window.__ysfxHud           last HUD lines (set by FlightHud)
 * Compiled out of production bundles (import.meta.env.DEV gate at the call site).
 */
import { useSeatContext } from '@xrift/world-components'
import { useRapier } from '@react-three/rapier'
import { useEffect } from 'react'
import { useEngine } from '../engine/engineStore'
import { setKioskJoin, setPendingJoin } from './lobbyStore'
import { NET_FLYING, readNetState, requestCommand, requestJoin, requestLeave, type NetState } from './netState'
import { setDevBodyLag } from './seatLead'
import { setDevPatchFocus } from './GroundPatch'
import { loadoutChange, loadoutSetAircraft, loadoutSetFuel, loadoutSetSmoke, readLoadout } from './loadout'

export function DevHooks({ onField, onApron }: { onField?: (field: string) => void; onApron?: (x: number, y: number, z: number) => void }) {
  const seat = useSeatContext() as unknown as Record<string, unknown>
  const mod = useEngine()
  const { world, rapier } = useRapier()
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
    w.__ysfxPatchFocus = (x?: number | null, z?: number | null) => { setDevPatchFocus(x == null || z == null ? null : { x, z }); return 'set' }
    w.__ysfxApronAt = (x: number, y: number, z: number) => { if (!onApron) return 'no apron'; onApron(x, y, z); return 'moved' }
    w.__ysfxGroundRay = (x: number, z: number) => {
      const top = 20000
      const hit = world.castRay(new rapier.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }), 2 * top, true)
      return hit ? top - hit.timeOfImpact : null
    }
    w.__ysfxLoadout = (air: string, changes: Array<[number, number]> = [], fuel?: number, smoke?: boolean) => {
      if (!mod) return 'engine not ready'
      loadoutSetAircraft(mod, air)
      for (const [type, n] of changes) loadoutChange(mod, type, n)
      if (fuel !== undefined) loadoutSetFuel(mod, fuel)
      if (smoke !== undefined) loadoutSetSmoke(mod, smoke)
      return readLoadout(mod)
    }
    w.__ysfxNetCommand = (cmd: number) => { if (!mod) return 'engine not ready'; requestCommand(mod, cmd); return 'queued' }
    return () => {
      delete w.__ysfxLobbyStart
      delete w.__ysfxNetCommand
      delete w.__ysfxLoadout
      delete w.__ysfxPatchFocus
      delete w.__ysfxGroundRay
      delete w.__ysfxApronAt
      delete w.__ysfxSit
      delete w.__ysfxStand
      delete w.__ysfxSetField
      delete w.__ysfxBodyLag
    }
  }, [seat, mod, onField, onApron, world, rapier])
  return null
}
