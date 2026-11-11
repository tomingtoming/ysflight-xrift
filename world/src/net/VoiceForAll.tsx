/**
 * VoiceForAll — everybody hears everybody, wherever they are.
 *
 * The host's voice chat fades with distance; here two people talking are
 * routinely kilometres apart (one in the air, one on the apron, or both in
 * the air).  toming, 2026-11-08: "start with everyone hearing everyone
 * regardless of distance; add a radio if that turns out to be a problem".
 *
 * useVoiceVolumeOverride is the host's hook for "the speaker on the stage is
 * heard everywhere": every remote user gets it, at full volume, for as long
 * as they are in the instance.  Each client does this for itself (the
 * override is local to the listener).  In the dev environment the hook is a
 * no-op.
 */
import { useUsers, useVoiceVolumeOverride } from '@xrift/world-components'
import { useEffect, useRef } from 'react'

/** Read-only, for the beacon: how many remote users this client has made audible everywhere. */
export const voiceStatus = { overrides: 0 }

export function VoiceForAll() {
  const { remoteUsers } = useUsers()
  const voice = useVoiceVolumeOverride()
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const applied = useRef(new Set<string>())
  const ids = remoteUsers.map((u) => u.id).sort().join(',')
  useEffect(() => {
    const now = new Set(ids ? ids.split(',') : [])
    for (const id of now) if (!applied.current.has(id)) { voiceRef.current.setOverride(id, 1.0); applied.current.add(id) }
    for (const id of [...applied.current]) if (!now.has(id)) { voiceRef.current.clearOverride(id); applied.current.delete(id) }
    voiceStatus.overrides = applied.current.size
  }, [ids])
  useEffect(() => () => {
    for (const id of applied.current) voiceRef.current.clearOverride(id)
    applied.current.clear()
    voiceStatus.overrides = 0
  }, [])
  return null
}
