/**
 * Who runs the server, for the panels that tell the visitor (toming,
 * 2026-11-13: the host hardly notices being the host).  NetSession writes it
 * on every render; the kiosk, the loading panel and the cockpit read it in
 * their own frame loops, so the host's heartbeat re-renders nobody else.
 */
import type { NetRole } from './NetSession'

let role: NetRole | null = null
let hostName = ''

export function setSessionRole(r: NetRole | null, name: string): void { role = r; hostName = name }
export function sessionRole(): NetRole | null { return role }
/** The host's XRift display name ('' while unknown). */
export function sessionHostName(): string { return hostName }

/** What being the host means for everyone else, in one line. */
export const HOST_DUTY = 'このタブを閉じる・裏に回す・ヘッドセットを外すと、全員の飛行がやり直しになります'
