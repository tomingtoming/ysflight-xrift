/**
 * prod-vr: the real XRift host inside an emulated immersive-vr session
 * (playwright-webxr / IWER).  Exercises the host's own VR interaction:
 * point the right controller at a pedestal, pull the trigger to sit, push the
 * thumbstick to steer, and capture both eyes.
 *
 * The seat position is known from World.tsx (pedestal RW01_01 at
 * [-123, 0.5, 646]); the avatar spawns at [-117, 0.5, 640] facing +z.
 * The VR entry button selector is the host's; override with YSFX_VR_BUTTON.
 */
import { expect, test } from 'playwright-webxr'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { NET_FLYING, enterWorld, waitForBeacon, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')
test.use({ xrStereoEnabled: true })

test('enter VR, sit by controller ray, steer by thumbstick', async ({ page, xr }, testInfo) => {
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

  // Thumbstick forward = stick forward through the host's seat control input:
  // the engine's VR stick block reads elevator < 0 (nose down).  Attitude is
  // not asserted -- the aircraft is parked with no airspeed.
  await xr.holdAxes('left', 0, -1, { ms: 1500, release: false })
  const b = await waitForBeacon(page, (x) => !!x.ctl && x.ctl[0] === 1 && x.ctl[2] < -0.5, 20_000, 'stick forward')
  expect(b.ctl![2]).toBeLessThan(-0.5)
  await xr.setAxes('left', 0, 0)
  const released = await waitForBeacon(page, (x) => !!x.ctl && Math.abs(x.ctl[2]) < 0.05, 10_000, 'stick released')
  expect(Math.abs(released.ctl![2])).toBeLessThan(0.05)
  await xr.attachCapture(testInfo, 'vr-steering')
})
