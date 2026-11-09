/**
 * prod-vr: the real XRift host inside an emulated immersive-vr session
 * (playwright-webxr / IWER).  Exercises the host's own VR interaction:
 * point the right controller at a pedestal, pull the trigger to sit, then the
 * world's SaccFlight-style hands (grip = stick / throttle, thumbstick dial +
 * trigger = functions), and capture both eyes.
 *
 * The seat position is known from World.tsx (pedestal RW01_01 at
 * [-123, 0.5, 646]); the avatar spawns at [-117, 0.5, 640] facing +z.
 * The VR entry button selector is the host's; override with YSFX_VR_BUTTON.
 */
import { expect, test } from 'playwright-webxr'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { NET_FLYING, enterWorld, lastBeacon, waitForBeacon, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')
test.use({ xrStereoEnabled: true })

test('enter VR, sit by controller ray, fly by SaccFlight-style hands', async ({ page, xr }, testInfo) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')

  await xr.enterVR({ button: process.env.YSFX_VR_BUTTON, timeout: 30_000 })
  await xr.waitForFrames(10)
  await xr.attachCapture(testInfo, 'vr-entered')

  // World -> tracking space: the beacon gives the XR camera's world pose, IWER
  // gives the same head's tracking pose; rig = camWorld * inv(headLocal).
  const bc = await waitForBeacon(page, (x) => !!x.cam && x.seats.length > 0, 20_000, 'camera pose + seats')
  const hp = await xr.headPose()
  const camWorld = new Matrix4().compose(new Vector3(...(bc.cam!.pos as [number, number, number])), new Quaternion(...(bc.cam!.quat as [number, number, number, number])), new Vector3(1, 1, 1))
  const headLocal = new Matrix4().compose(new Vector3(...(hp.position as [number, number, number])), new Quaternion(...(hp.quaternion as [number, number, number, number])), new Vector3(1, 1, 1))
  const worldToLocal = camWorld.multiply(headLocal.invert()).invert()
  // Nearest pedestal; aim at the centre of its hit box (0.5 m above the seat
  // origin).  The hand is placed in WORLD terms -- level with the target, 3 m
  // in front of it on the camera side -- then mapped to tracking space, so the
  // ray never starts under the floor whatever height the host gives the rig.
  const camPos = new Vector3(...(bc.cam!.pos as [number, number, number]))
  const seats = bc.seats.map((s) => ({ id: s.id, w: new Vector3(s.pos[0], s.pos[1] + 0.5, s.pos[2]) }))
  seats.sort((a, b) => a.w.distanceTo(camPos) - b.w.distanceTo(camPos))
  const targetW = seats[0].w
  const back = new Vector3(camPos.x - targetW.x, 0, camPos.z - targetW.z).normalize()
  const handW = targetW.clone().addScaledVector(back, 3)
  const target = targetW.clone().applyMatrix4(worldToLocal).toArray() as [number, number, number]
  const hand = handW.clone().applyMatrix4(worldToLocal).toArray() as [number, number, number]
  testInfo.annotations.push({ type: 'aim', description: `${seats[0].id}: hand local ${hand.map((n) => n.toFixed(2)).join(',')} -> target local ${target.map((n) => n.toFixed(2)).join(',')}` })
  // The host's controller ray is NOT the WebXR target ray: it starts at the
  // GRIP pose and points along the grip's -Z pitched 45 deg down (the real
  // Quest grip is tilted up by about that).  IWER's grip carries the Quest
  // profile's offset (about 7 deg of yaw too), so aim the grip directly: the
  // orientation that takes (0,-sin45,-cos45) onto the hand->target direction.
  const GRIP_RAY = new Vector3(0, -Math.SQRT1_2, -Math.SQRT1_2)
  const dir = new Vector3(...target).sub(new Vector3(...hand)).normalize()
  const gripQ = new Quaternion().setFromUnitVectors(GRIP_RAY, dir)
  await xr.setGripPose('right', { position: hand, quaternion: gripQ.toArray() as [number, number, number, number] })
  // The host re-evaluates the controller ray every 7th frame and only acts on
  // a trigger whose rising edge lands on an already-hovered target: give the
  // hover two polls, then press; retry once if the edge was missed.
  await xr.waitForFrames(24)
  await xr.attachCapture(testInfo, 'vr-aimed')
  let seated = null as Awaited<ReturnType<typeof waitForBeacon>> | null
  for (let attempt = 0; attempt < 3 && !seated; attempt++) {
    await xr.pressButton('right', 'trigger', { holdMs: 400, frames: 12 })
    await xr.waitForFrames(10)
    if (attempt === 0) await xr.attachCapture(testInfo, 'vr-triggered')
    seated = await waitForBeacon(page, (b) => b.seat !== null, 4_000, 'seated after trigger').catch(() => null)
    await xr.waitForFrames(14)
  }
  if (!seated) throw new Error('not seated after 3 trigger presses')
  testInfo.annotations.push({ type: 'seat', description: seated.seat ?? '' })
  const flying = await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING, 40_000, 'flying after trigger')
  expect(flying.aircraft.some((a) => a.player)).toBe(true)
  await xr.attachCapture(testInfo, 'vr-seated')

  // The seat measures the headset 1.0-1.5 s after sitting and moves its
  // origin so the eye lands on the engine's cockpit point (seatEye.ts).
  const eye = await waitForBeacon(page, (x) => !!x.eye && x.eye.n > 0 && Math.abs(x.eye.res[1]) < 0.05 && Math.abs(x.eye.res[2]) < 0.05, 10_000, 'eye on the cockpit point')
  console.log(`[vr eye] hip-to-eye ${eye.eye!.dy.toFixed(3)} m, ahead ${(-eye.eye!.dz).toFixed(3)} m, residual ${eye.eye!.res.map((n) => n.toFixed(3)).join(',')}`)

  // ---- SaccFlight-style hands (src/vr/saccControls.ts) --------------------
  // Stick: squeeze the right grip, then tilt the wrist.  Deflections are the
  // grip's rotation since the grab in room axes: pitching the controller's
  // nose up 20 deg about room X reads as elevator +20/45; rolling it 25 deg
  // clockwise about room Z (right vector dips) reads as aileron +25/45.
  await xr.hold('right', 'squeeze', { value: 1, frames: 4 })
  await waitForBeacon(page, (x) => x.vr.active && x.vr.right.grabbed, 5_000, 'stick grabbed')
  const q = (r: Quaternion) => r.toArray() as [number, number, number, number]
  const pitchQ = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (20 * Math.PI) / 180).multiply(gripQ)
  await xr.setGripPose('right', { position: hand, quaternion: q(pitchQ) })
  const up = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[2] > 0.3 && Math.abs(x.ctl[1]) < 0.15, 5_000, 'elevator up from the wrist')
  console.log(`[vr stick] pitch 20deg -> ail ${up.ctl![1].toFixed(2)} elv ${up.ctl![2].toFixed(2)} rud ${up.ctl![3].toFixed(2)}`)
  const rollQ = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (-25 * Math.PI) / 180).multiply(gripQ)
  await xr.setGripPose('right', { position: hand, quaternion: q(rollQ) })
  const roll = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[1] > 0.3 && Math.abs(x.ctl[2]) < 0.15, 5_000, 'aileron right from the wrist')
  console.log(`[vr stick] roll -25deg -> ail ${roll.ctl![1].toFixed(2)} elv ${roll.ctl![2].toFixed(2)} rud ${roll.ctl![3].toFixed(2)}`)
  await xr.attachCapture(testInfo, 'vr-stick')
  await xr.release('right', 'squeeze', { frames: 4 })
  await xr.setGripPose('right', { position: hand, quaternion: q(gripQ) })
  await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 0 && Math.abs(x.ctl[1]) < 0.05 && Math.abs(x.ctl[2]) < 0.05, 5_000, 'stick released and centred')

  // Throttle: squeeze the left grip and push it forward (the head's yaw gives
  // "forward"); 1/6 m is the whole 0..1 range.  Released, the lever stays.
  const head = await xr.headPose()
  const fwd = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...(head.quaternion as [number, number, number, number])))
  fwd.y = 0
  fwd.normalize()
  const lp = new Vector3(hand[0] - 0.4, hand[1], hand[2])
  await xr.setGripPose('left', { position: lp.toArray() as [number, number, number], quaternion: [0, 0, 0, 1] })
  await xr.waitForFrames(4)
  await xr.hold('left', 'squeeze', { value: 1, frames: 4 })
  await waitForBeacon(page, (x) => x.vr.left.grabbed, 5_000, 'throttle grabbed')
  await xr.setGripPose('left', { position: lp.clone().addScaledVector(fwd, 0.1).toArray() as [number, number, number], quaternion: [0, 0, 0, 1] })
  const thr = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[4] === 1 && x.ctl[5] > 0.5 && x.ctl[5] < 0.75, 5_000, 'throttle ~0.6 from a 10 cm push')
  console.log(`[vr throttle] 10 cm -> ${thr.ctl![5].toFixed(2)}`)
  await xr.release('left', 'squeeze', { frames: 4 })
  const kept = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[4] === 0 && x.ctl[5] > 0.5, 5_000, 'throttle lever stays where left')
  console.log(`[vr throttle] released -> ${kept.ctl![5].toFixed(2)} (grabbed ${kept.ctl![4]})`)
  // Rolling at 60 % throttle: once past 40 m/s the rig must sit on the
  // cockpit (the kinematic body adds pipeline frames in VR; seatLead.ts
  // measures them and leads the seat surface).
  const fast = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40, 90_000, 'speed > 40 m/s')
  console.log(`[vr lag:first] speed ${fast.lag!.speed.toFixed(1)} m/s, camera lag ${fast.lag!.eFrames.toFixed(2)} frames, lead ${fast.lag!.leadMs.toFixed(1)} ms`)
  await xr.waitForFrames(90)
  const settled = await waitForBeacon(page, (x) => !!x.lag && x.lag.speed > 40 && Math.abs(x.lag.eFrames) < 0.3, 10_000, 'rig on the cockpit at speed')
  console.log(`[vr lag:settled] speed ${settled.lag!.speed.toFixed(1)} m/s, camera lag ${settled.lag!.eFrames.toFixed(2)} frames, lead ${settled.lag!.leadMs.toFixed(1)} ms`)
  await xr.attachCapture(testInfo, 'vr-fast')

  // Function dial: pull the right thumbstick to 240 deg (sector 4 = Brake),
  // the placard shows, the trigger fires the picked function: the engine's
  // brake/spoiler flag (flight[10]) toggles.
  // Bring the right hand to where a pilot holds a stick (0.45 m ahead of
  // the head, 0.25 m below) so the placard above it is in view.
  const headP = new Vector3(...(head.position as [number, number, number]))
  const stickHand = headP.clone().addScaledVector(fwd, 0.45).add(new Vector3(0.1, -0.25, 0))
  await xr.setGripPose('right', { position: stickHand.toArray() as [number, number, number], quaternion: q(gripQ) })
  await xr.waitForFrames(4)
  const brake0 = (await lastBeacon(page))!.flight![10]
  // xr-standard thumbstick: +y is toward the user, so 240 deg clockwise from up is x=-0.87, y=+0.5.
  await xr.setAxes('right', Math.sin((240 * Math.PI) / 180), -Math.cos((240 * Math.PI) / 180))
  const pick = await waitForBeacon(page, (x) => x.vr.right.sel === 4 && x.vr.right.visible, 5_000, 'dial sector Brake picked')
  console.log(`[vr dial] right sel ${pick.vr.right.sel} visible ${pick.vr.right.visible} placard world ${pick.vr.right.pos.map((n) => n.toFixed(2)).join(',')} cam ${pick.cam!.pos.map((n) => n.toFixed(2)).join(',')}`)
  await xr.attachCapture(testInfo, 'vr-dial')
  await xr.pressButton('right', 'trigger', { holdMs: 150, frames: 6 })
  const fired = await waitForBeacon(page, (x) => x.vr.lastKey === 'KeyB', 5_000, 'Brake key dispatched')
  console.log(`[vr dial] keys ${fired.vr.keys} last ${fired.vr.lastKey}`)
  await xr.setAxes('right', 0, 0)
  const brake = await waitForBeacon(page, (x) => !!x.flight && Math.abs(x.flight[10] - brake0) > 0.5, 10_000, 'brake toggled by the dial')
  console.log(`[vr dial] brake ${brake0} -> ${brake.flight![10]}`)
  await waitForBeacon(page, (x) => !x.vr.right.visible, 5_000, 'dial placard hidden after recentring')
})

// LobbyKiosk geometry, as in prod-pc.spec.ts: the 飛行開始 button centre.
const KIOSK: [number, number, number] = [-117 + 8, 1.6, 640 + 5]
const START_BTN: [number, number, number] = [KIOSK[0] - (1700 / 2 - 28 - 160) / 1000, KIOSK[1] - (1000 / 2 - 28 - 40) / 1000, KIOSK[2]]

test('VR: kiosk 飛行開始 by controller ray, then leave by holding A', async ({ page, xr }, testInfo) => {
  await watchBeacon(page)
  await enterWorld(page, WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')
  await waitForBeacon(page, (x) => !!x.lobby && x.lobby[0] > 10, 30_000, 'kiosk lists')
  await xr.enterVR({ button: process.env.YSFX_VR_BUTTON, timeout: 30_000 })
  await xr.waitForFrames(10)

  const bc = await waitForBeacon(page, (x) => !!x.cam, 20_000, 'camera pose')
  const hp = await xr.headPose()
  const camWorld = new Matrix4().compose(new Vector3(...(bc.cam!.pos as [number, number, number])), new Quaternion(...(bc.cam!.quat as [number, number, number, number])), new Vector3(1, 1, 1))
  const headLocal = new Matrix4().compose(new Vector3(...(hp.position as [number, number, number])), new Quaternion(...(hp.quaternion as [number, number, number, number])), new Vector3(1, 1, 1))
  const worldToLocal = camWorld.multiply(headLocal.invert()).invert()
  const camPos = new Vector3(...(bc.cam!.pos as [number, number, number]))
  const targetW = new Vector3(...START_BTN)
  // The panel faces -z (yaw PI): stand on its front side, 2.5 m out, level with the button.
  const back = new Vector3(camPos.x - targetW.x, 0, camPos.z - targetW.z).normalize()
  const handW = targetW.clone().addScaledVector(back, 2.5)
  const target = targetW.clone().applyMatrix4(worldToLocal).toArray() as [number, number, number]
  const hand = handW.clone().applyMatrix4(worldToLocal).toArray() as [number, number, number]
  console.log(`[vr kiosk] cam ${camPos.toArray().map((n) => n.toFixed(2))} hand world ${handW.toArray().map((n) => n.toFixed(2))} -> button ${START_BTN.map((n) => n.toFixed(2))}`)
  // uikit panels are NOT reached by the host's own seat ray (grip, -45 deg,
  // layer INTERACTABLE): the host enables @react-three/xr's default
  // controller ray pointer (invisible ray model) along the WebXR TARGET RAY,
  // and the trigger's select event becomes an ordinary pointer click on the
  // panel.  So aim the target ray (-Z) at the button.
  const dir = new Vector3(...target).sub(new Vector3(...hand)).normalize()
  const rayQ = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), dir)
  await xr.setControllerPose('right', { position: hand, quaternion: rayQ.toArray() as [number, number, number, number] })
  await xr.waitForFrames(24)
  // Photograph the panel from the headset: turn the head toward the button.
  const headBefore = await xr.headPose()
  const eyeW = camPos.clone()
  const toBtn = targetW.clone().sub(eyeW).normalize()
  const lookQ = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), toBtn)
  const camQ = new Quaternion(...(bc.cam!.quat as [number, number, number, number]))
  const headQ = new Quaternion(...(hp.quaternion as [number, number, number, number]))
  const rigQ = camQ.clone().multiply(headQ.clone().invert())
  await xr.setHeadPose({ quaternion: rigQ.clone().invert().multiply(lookQ).toArray() as [number, number, number, number] })
  await xr.waitForFrames(12)
  await xr.attachCapture(testInfo, 'vr-kiosk-aimed')
  await xr.setHeadPose({ quaternion: headBefore.quaternion as [number, number, number, number] })
  await xr.waitForFrames(6)
  console.log(`[vr kiosk] hover before trigger: ${JSON.stringify((await waitForBeacon(page, () => true, 2_000)).kiosk)}`)
  // Diagnostic: count the WebXR select events IWER emits on the session.
  await page.evaluate(() => {
    const dev = (globalThis as unknown as { __xrDevice?: { activeSession?: EventTarget } }).__xrDevice
    const s = dev?.activeSession
    const c = ((globalThis as unknown as { __ysfxSel?: Record<string, number> }).__ysfxSel = { selectstart: 0, select: 0, selectend: 0 })
    for (const t of Object.keys(c)) s?.addEventListener(t, () => { c[t]++ })
  })
  let seated = null as Awaited<ReturnType<typeof waitForBeacon>> | null
  for (let attempt = 0; attempt < 3 && !seated; attempt++) {
    // A short press: the pointer library turns down+up into a click only
    // within a time threshold (a 400 ms hold gave down/up but no click).
    await xr.pressButton('right', 'trigger', { holdMs: 80, frames: 4 })
    await xr.waitForFrames(10)
    console.log(`[vr kiosk] session select events: ${JSON.stringify(await page.evaluate(() => (globalThis as unknown as { __ysfxSel?: unknown }).__ysfxSel))}`)
    const bb = await waitForBeacon(page, () => true, 2_000)
    console.log(`[vr kiosk] after trigger ${attempt}: lobby ${JSON.stringify(bb.lobby)} kiosk ${JSON.stringify(bb.kiosk)}`)
    seated = await waitForBeacon(page, (b) => b.seat === 'ysfx-cockpit', 15_000, 'auto-seated').catch(() => null)
    await xr.waitForFrames(14)
  }
  if (!seated) throw new Error('not seated after 3 trigger presses on 飛行開始')
  expect(seated.net!.state).toBe(NET_FLYING)
  await waitForBeacon(page, (b) => !!b.hud && /SPD/.test(b.hud[0]), 10_000, 'HUD')
  await xr.attachCapture(testInfo, 'vr-kiosk-flying')

  // Leave: the host's VR "stand up" is the A button held (like Space held on desktop).
  let left = null as Awaited<ReturnType<typeof waitForBeacon>> | null
  for (const id of ['a-button', 'b-button'] as const) {
    await xr.pressButton('right', id, { holdMs: 800, frames: 48 })
    left = await waitForBeacon(page, (b) => b.seat === null, 6_000, `left after ${id}`).catch(() => null)
    console.log(`[vr kiosk] after holding ${id}: seat ${(await waitForBeacon(page, () => true, 2_000)).seat}`)
    if (left) break
  }
  if (!left) throw new Error(`still seated after holding A and B: ${JSON.stringify((await waitForBeacon(page, () => true, 2_000)).seat)}`)
  expect(left.seat).toBeNull()
  await xr.attachCapture(testInfo, 'vr-kiosk-left')
})
