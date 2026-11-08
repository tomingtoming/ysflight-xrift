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
import { aimQuaternion } from 'playwright-webxr/examples/aim-controller'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { NET_FLYING, waitForBeacon, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')
test.use({ xrStereoEnabled: true })

test('enter VR, sit by controller ray, steer by thumbstick', async ({ page, xr }, testInfo) => {
  await watchBeacon(page)
  await page.goto(WORLD_URL)
  await waitForBeacon(page, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'session ready')

  await xr.enterVR({ button: process.env.YSFX_VR_BUTTON, timeout: 30_000 })
  await xr.waitForFrames(10)
  await xr.attachCapture(testInfo, 'vr-entered')

  // Aim the right controller from the hand at the pedestal and pull the trigger.
  // Coordinates are tracking space (the avatar's local frame); the pedestal is
  // ~6 m ahead-left of the spawn. Adjust once the host's spawn frame is known.
  const hand: [number, number, number] = [0.2, 1.2, -0.3]
  const target: [number, number, number] = [-6, 0.6, -6]
  await xr.setControllerPose('right', { position: hand, quaternion: aimQuaternion(hand, target) })
  await xr.waitForFrames(5)
  await xr.pressButton('right', 'trigger')

  const flying = await waitForBeacon(page, (b) => !!b.net && b.net.state === NET_FLYING, 40_000, 'flying after trigger')
  expect(flying.aircraft.some((a) => a.player)).toBe(true)
  await xr.attachCapture(testInfo, 'vr-seated')

  // Thumbstick forward = nose down through the host's seat control input.
  await xr.holdAxes('left', 0, -1, { ms: 1500, release: false })
  const b = await waitForBeacon(page, (x) => !!x.flight && x.flight[4] < -0.02, 20_000, 'pitch down')
  expect(b.flight![4]).toBeLessThan(0)
  await xr.setAxes('left', 0, 0)
  await xr.attachCapture(testInfo, 'vr-steering')
})
