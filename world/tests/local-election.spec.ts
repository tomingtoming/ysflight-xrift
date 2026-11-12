/**
 * local-election: the host-seat rules (src/net/election.ts) on simulated
 * visitors.  No browser: the dev environment does not share instance state
 * between tabs, so the rules are exercised here on a shared state object and
 * a clock, the way NetSession applies them (decide every 500 ms, mayClaim on
 * the state as it is when the claim is written).
 */
import { expect, test } from '@playwright/test'
import { BEAT_MS, CLASS_DESKTOP, CLASS_HEADSET, CLASS_PHONE, decide, deviceClass, mayClaim, type ElectionState } from '../src/net/election'

interface Sim { id: string; cls: number; awake: boolean; flying: boolean; vacantSince: number | null; beatSeenAt: number; beatKey: string; idleSince: number | null; lastBeatAt: number }
class Instance {
  now = 0
  state: ElectionState = { hostId: null }
  peers: Sim[] = []
  log: string[] = []
  join(id: string, cls: number) { this.peers.push({ id, cls, awake: true, flying: false, vacantSince: null, beatSeenAt: this.now, beatKey: '', idleSince: null, lastBeatAt: this.now }) }
  leave(id: string) { this.peers = this.peers.filter((p) => p.id !== id) }
  peer(id: string) { return this.peers.find((p) => p.id === id)! }
  run(ms: number) {
    for (const end = this.now + ms; this.now < end;) {
      this.now += 500
      const present = this.peers.map((p) => p.id)
      const anyoneFlying = this.peers.some((p) => p.flying)
      for (const p of this.peers) {
        if (!p.awake) continue // a sleeping browser runs nothing: no beat, no claim
        const s = this.state
        if (s.hostId === p.id && this.now - p.lastBeatAt >= BEAT_MS) { p.lastBeatAt = this.now; this.state = { ...s, beat: (s.beat ?? 0) + 1 } }
        const held = this.state.hostId !== null && present.includes(this.state.hostId)
        if (held) p.vacantSince = null
        else if (p.vacantSince === null) p.vacantSince = this.now
        const key = `${this.state.hostId}:${this.state.beat}`
        if (key !== p.beatKey) { p.beatKey = key; p.beatSeenAt = this.now }
        // Clients see who flies through their engine; it takes the engine a few seconds to connect after a restart.
        if (this.state.hostId === p.id || anyoneFlying) p.idleSince = null
        else if (p.idleSince === null) p.idleSince = this.now
        const reason = decide({ now: this.now, me: p, present, state: this.state, vacantSince: p.vacantSince, beatSeenAt: p.beatSeenAt, idleSince: p.idleSince })
        if (reason && mayClaim(reason, this.state, p, present, this.state.beat)) {
          this.log.push(`${(this.now / 1000).toFixed(1)}s ${p.id} (${reason})`)
          this.state = { hostId: p.id, hostClass: p.cls, beat: 0 }
          p.lastBeatAt = this.now
          for (const q of this.peers) q.idleSince = null // every engine restarts
        }
      }
    }
  }
}

test('device classes from the user agent', () => {
  expect(deviceClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36', false)).toBe(CLASS_DESKTOP)
  expect(deviceClass('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 OculusBrowser/40.0 Chrome/138.0 VR Safari/537.36', false)).toBe(CLASS_HEADSET)
  expect(deviceClass('Mozilla/5.0 (Linux; Android 14; Quest 3) AppleWebKit/537.36 OculusBrowser/40.0 Chrome/138.0 Mobile VR Safari/537.36', true)).toBe(CLASS_HEADSET)
  expect(deviceClass('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36', true)).toBe(CLASS_PHONE)
  expect(deviceClass('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', true)).toBe(CLASS_PHONE)
})

test('arriving together: the desktop takes the seat, whatever the ids', () => {
  const i = new Instance()
  i.join('a-quest', CLASS_HEADSET); i.join('b-phone', CLASS_PHONE); i.join('z-desktop', CLASS_DESKTOP)
  i.run(30_000)
  console.log(`[election] together: ${i.log.join(', ')}`)
  expect(i.state.hostId).toBe('z-desktop')
  expect(i.log).toHaveLength(1)
})

test('alone, a headset still becomes the host; a desktop that comes later takes over only while nobody flies', () => {
  const i = new Instance()
  i.join('quest', CLASS_HEADSET)
  i.run(20_000)
  expect(i.state.hostId).toBe('quest')
  i.peer('quest').flying = true
  i.join('desktop', CLASS_DESKTOP)
  i.run(60_000)
  expect(i.state.hostId).toBe('quest') // not over a flight
  i.peer('quest').flying = false
  i.run(30_000)
  console.log(`[election] upgrade: ${i.log.join(', ')}`)
  expect(i.state.hostId).toBe('desktop')
  // And it settles: the headset does not take it back, a phone that joins does not either.
  i.join('phone', CLASS_PHONE)
  i.run(120_000)
  expect(i.state.hostId).toBe('desktop')
  expect(i.log).toHaveLength(2)
})

test('a host that falls asleep is replaced by the best device awake, once; awake again it stays a client', () => {
  const i = new Instance()
  i.join('desktop', CLASS_DESKTOP); i.join('phone', CLASS_PHONE); i.join('quest', CLASS_HEADSET)
  i.run(15_000)
  expect(i.state.hostId).toBe('desktop')
  i.peer('phone').flying = true // a stall is taken over even mid-flight: the session is frozen anyway
  i.peer('desktop').awake = false
  i.run(19_000)
  expect(i.state.hostId).toBe('desktop') // not yet: four beats may be missed
  i.run(20_000)
  console.log(`[election] stall: ${i.log.join(', ')}`)
  expect(i.state.hostId).toBe('phone')
  i.peer('desktop').awake = true
  i.peer('phone').flying = false
  i.run(10_000)
  expect(i.state.hostId).toBe('phone') // within the idle wait
  i.run(60_000)
  // The desktop is the better device and nobody flies: it takes the seat back, by rule 3, not by waking up.
  expect(i.state.hostId).toBe('desktop')
  expect(i.log.map((l) => l.replace(/^[\d.]+s /, ''))).toEqual(['desktop (vacant)', 'phone (stalled)', 'desktop (better)'])
})

test('the host leaves: the next best device present claims', () => {
  const i = new Instance()
  i.join('desktop', CLASS_DESKTOP); i.join('quest-b', CLASS_HEADSET); i.join('quest-a', CLASS_HEADSET)
  i.run(15_000)
  i.leave('desktop')
  i.run(30_000)
  console.log(`[election] leave: ${i.log.join(', ')}`)
  expect(i.state.hostId).toBe('quest-a') // same class: the lower id
  expect(i.log).toHaveLength(2)
})
