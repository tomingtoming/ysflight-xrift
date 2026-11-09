/**
 * prod-multi: two browser contexts (same logged-in account) in ONE XRift
 * instance on the real host.  Verifies the host election (one host, one
 * client), the client engine connecting to the host's signaling room over
 * WebRTC, and the host's aircraft showing up in the client's aircraft list
 * after the host starts a flight at the kiosk.
 *
 * Needs local WebRTC P2P to work: Cloudflare WARP on this Mac breaks it
 * (keel), so run with WARP off.
 */
import { expect, test, type Browser, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { HAS_AUTH, WORLD_URL } from './playwright.config'
import { enterWorld, lastBeacon, NET_FLYING, waitForBeacon, walkAndAim, watchBeacon } from './helpers'

test.skip(!HAS_AUTH, 'no tests/.auth/xrift.json -- run `npm run test:auth` once')

const AUTH = resolve(import.meta.dirname, '.auth/xrift.json')
const DEG_PER_PX = 0.115
// The kiosk's 飛行開始 button centre comes from the beacon (the kiosk is placed per field).

async function newPilot(browser: Browser, auth: boolean): Promise<Page> {
  // The second pilot is a GUEST: the host drops the earlier connection of
  // the same account ("別のタブまたはデバイスから接続されたため…", measured
  // 2026-11-09), so two pilots need two identities.  An instance URL opened
  // without a login offers "ゲストとして参加".
  // `browser.newContext` inherits the project's `use` (incl. storageState):
  // the guest must override it explicitly, or it logs in as the same account
  // and the host drops the first session.
  const ctx = await browser.newContext({ storageState: auth ? AUTH : undefined, permissions: ['microphone'], locale: 'ja-JP', viewport: { width: 1280, height: 720 } })
  const page = await ctx.newPage()
  await watchBeacon(page)
  return page
}

async function enterAsGuest(page: Page, instanceUrl: string, name: string) {
  await page.goto(instanceUrl)
  const nameBox = page.getByRole('textbox').first()
  const enterBtn = page.getByRole('button', { name: /入室する/ })
  const first = await Promise.any([
    nameBox.waitFor({ timeout: 60_000 }).then(() => 'name'),
    enterBtn.waitFor({ timeout: 60_000 }).then(() => 'enter'),
    page.waitForFunction(() => !!(window as unknown as { __ysfxTestBeacon?: unknown }).__ysfxTestBeacon, null, { timeout: 60_000 }).then(() => 'world'),
  ]).catch(async (e) => {
    console.log(`[guest] nothing appeared at ${page.url()}: ${(await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`)
    throw e
  })
  console.log(`[guest] first: ${first} at ${page.url()}`)
  if (first === 'world') return
  if (first === 'name') {
    await nameBox.fill(name)
    await page.getByRole('button', { name: /この名前で参加/ }).click()
    await enterBtn.waitFor({ timeout: 60_000 })
  }
  // A guest is asked to acknowledge the world's external connections
  // (signaling host, STUN, WebRTC) before 入室する enables.
  const consent = page.getByRole('checkbox').first()
  if (await consent.isVisible().catch(() => false)) await consent.check()
  await enterBtn.click()
}

async function kioskStart(page: Page) {
  // Pointer lock needs the focused window: with two contexts open only the
  // front one gets it (the first run left the host camera unturned).
  await page.bringToFront()
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(640, 360)
    await page.waitForTimeout(800)
    if (await page.evaluate(() => !!document.pointerLockElement)) break
  }
  expect(await page.evaluate(() => !!document.pointerLockElement)).toBe(true)
  let mx = 640, my = 360
  const look = async (dyaw: number, dpitch: number) => {
    const dx = -dyaw / DEG_PER_PX, dy = -dpitch / DEG_PER_PX
    mx += dx; my += dy
    await page.mouse.move(mx, my, { steps: Math.max(2, Math.ceil(Math.hypot(dx, dy) / 20)) })
    await page.waitForTimeout(350)
  }
  const walk = async (ms: number) => { await page.keyboard.down('w'); await page.waitForTimeout(ms); await page.keyboard.up('w') }
  const START_BTN = (await waitForBeacon(page, (x) => !!x.kioskBtn, 10_000, 'kiosk button position')).kioskBtn!
  const aim = await walkAndAim(page, look, walk, 2.4, { id: 'kiosk-start', p: START_BTN })
  console.log(`[kiosk aim] dist ${aim.dist.toFixed(2)} dyaw ${aim.dyaw.toFixed(1)} dpitch ${aim.dpitch.toFixed(1)}`)
  await page.mouse.click(mx, my)
}

test('two pilots in one instance: host + client, client sees the host aircraft', async ({ browser }) => {
  test.setTimeout(420_000)
  const a = await newPilot(browser, true)
  const instanceUrl = await enterWorld(a, WORLD_URL)
  console.log(`[multi] instance ${instanceUrl}`)
  const ba = await waitForBeacon(a, (x) => x.role !== null && !!x.net && x.net.ready, 150_000, 'A session ready')
  console.log(`[multi] A role ${ba.role} room ${ba.room}`)

  const b = await newPilot(browser, false)
  await enterAsGuest(b, instanceUrl, 'ysfx-guest')
  const bb = await waitForBeacon(b, (x) => x.role !== null && !!x.net, 120_000, 'B has a role')
  console.log(`[multi] B role ${bb.role} room ${bb.room}`)
  await a.screenshot({ path: test.info().outputPath('multi-a.png') })
  await b.screenshot({ path: test.info().outputPath('multi-b.png') })

  const roles = [ba.role, (await lastBeacon(a))?.role, bb.role].filter(Boolean)
  console.log(`[multi] roles after B joined: A=${(await lastBeacon(a))?.role} B=${bb.role}`)
  expect(new Set([(await lastBeacon(a))?.role, bb.role])).toEqual(new Set(['host', 'client']))
  const host = (await lastBeacon(a))?.role === 'host' ? a : b
  const client = host === a ? b : a

  // The client engine must reach the host over WebRTC (net.ready on the
  // client only turns on once the yssocket handshake completed).
  const cr = await waitForBeacon(client, (x) => !!x.net && x.net.ready, 90_000, 'client connected to host')
  console.log(`[multi] client ready: ${JSON.stringify(cr.net)}`)
  const hr = await waitForBeacon(host, (x) => !!x.net && x.net.connected >= 1, 30_000, 'host counts one client')
  console.log(`[multi] host net: ${JSON.stringify(hr.net)}`)

  // Host flies from the kiosk; the client must see that aircraft.
  await kioskStart(host)
  const hf = await waitForBeacon(host, (x) => !!x.net && x.net.state === NET_FLYING && x.seat === 'ysfx-cockpit', 40_000, 'host flying')
  const hostAir = hf.aircraft.find((x) => x.player)
  console.log(`[multi] host aircraft: ${JSON.stringify(hostAir)}`)
  const seen = await waitForBeacon(client, (x) => x.aircraft.some((ac) => ac.alive && !ac.player), 30_000, 'client sees host aircraft')
  const remote = seen.aircraft.filter((ac) => ac.alive && !ac.player)
  console.log(`[multi] client sees: ${JSON.stringify(remote)}`)
  expect(remote.length).toBeGreaterThanOrEqual(1)
  await host.screenshot({ path: test.info().outputPath('multi-host-flying.png') })
  await client.screenshot({ path: test.info().outputPath('multi-client-sees.png') })

  // Client flies too; the host must see two aircraft.
  await kioskStart(client)
  const cf = await waitForBeacon(client, (x) => !!x.net && x.net.state === NET_FLYING && x.seat === 'ysfx-cockpit', 40_000, 'client flying')
  console.log(`[multi] client aircraft: ${JSON.stringify(cf.aircraft.find((x) => x.player))}`)
  const both = await waitForBeacon(host, (x) => x.aircraft.filter((ac) => ac.alive).length >= 2, 30_000, 'host sees two aircraft')
  console.log(`[multi] host sees: ${JSON.stringify(both.aircraft.filter((ac) => ac.alive))}`)
  await host.screenshot({ path: test.info().outputPath('multi-host-two.png') })
  await client.screenshot({ path: test.info().outputPath('multi-client-two.png') })

  // Hidden-tab ticker: headless windows never report document.hidden (the
  // other context stayed "visible" while the client was in front, bg stayed
  // 0), so the path is exercised by faking `hidden` for a moment.  Chrome's
  // 1 Hz throttling itself is not reproduced here.
  await host.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }))
  await host.waitForTimeout(2000)
  const hb = await lastBeacon(host)
  await host.evaluate(() => { delete (document as unknown as Record<string, unknown>).hidden })
  console.log(`[multi] host background ticks over 2 s with hidden=true: ${hb?.bg}`)
  expect(hb!.bg).toBeGreaterThan(20)
  expect((await lastBeacon(host))!.net!.state).toBe(NET_FLYING)

  for (const p of [host, client]) {
    await p.bringToFront() // the seat loop (useFrame) only runs in a visible tab
    await p.waitForTimeout(300)
    await p.keyboard.down('Space'); await p.waitForTimeout(600); await p.keyboard.up('Space')
    await waitForBeacon(p, (x) => x.seat === null, 8_000, 'left seat')
  }
})
