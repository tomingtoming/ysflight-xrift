/**
 * StandbyBoard — trial: the engine's original multiplayer standby screen
 * (console, chat log, the standby dialog) shown as-is on a board beside the
 * kiosk.  Display only; enabled with ?ysfxboard=1 (engine/menuTarget.ts).
 */
import { DoubleSide } from 'three'
import { useMenuTexture } from '../engine/engineStore'
import { MENU_H, MENU_W } from '../engine/menuTarget'

const BOARD_W = 1.6

export function StandbyBoard({ position, yaw = 0 }: { position: [number, number, number]; yaw?: number }) {
  const texture = useMenuTexture()
  if (!texture) return null
  return (
    <mesh position={position} rotation={[0, yaw, 0]}>
      <planeGeometry args={[BOARD_W, (BOARD_W * MENU_H) / MENU_W]} />
      <meshBasicMaterial map={texture} toneMapped={false} side={DoubleSide} />
    </mesh>
  )
}
