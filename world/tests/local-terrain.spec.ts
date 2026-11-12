/**
 * local-terrain: the walkable ground follows the engine's terrain.
 *
 * GroundPatch lays a heightfield collider of the engine's elevations under
 * the local player.  Two things are checked against the engine's own
 * single-point answer (fsvr.h ground probe):
 *   - on the apron the visitor stands on that heightfield (the flat stand-in
 *     floor is gone once the field is loaded);
 *   - on a slope, a physics ray straight down hits the collider where the
 *     engine says the ground is -- at points all over the patch, which a
 *     mirrored or transposed grid would miss by metres.
 * Slopes are far from any apron, so the patch is laid around a focus point
 * (dev hook) instead of the player; the player never leaves the apron.
 */
import { expect, test, type Page } from '@playwright/test'
import { lastBeacon, waitForBeacon, watchBeacon, type Beacon } from './helpers'

const ROOM = '12345684'
const FIELDS = (process.env.YSFX_TERRAIN_FIELDS ?? 'HAWAII').split(',')
const SNAP = 8

type Hooks = { __ysfxApronAt: (x: number, y: number, z: number) => string; __ysfxPatchFocus: (x?: number | null, z?: number | null) => string; __ysfxGroundRay: (x: number, z: number) => number | null; __ysfxSetField: (f: string) => string }

/** Lay the patch around (x, z) and wait until both the patch and the probe answer for it. */
async function focus(page: Page, x: number, z: number): Promise<Beacon> {
  await page.evaluate(([px, pz]) => (window as unknown as Hooks).__ysfxPatchFocus(px, pz), [x, z])
  const cx = Math.round(x / SNAP) * SNAP, cz = Math.round(z / SNAP) * SNAP
  const t0 = Date.now()
  let seen = 0
  for (;;) {
    const b = await lastBeacon(page)
    // Two fresh beacons with the patch in place: the probe answer in the second belongs to this point.
    if (b && b.t > t0 && b.ground.patch && b.ground.patch.cx === cx && b.ground.patch.cz === cz && b.ground.field != null) { if (++seen >= 3) return b } else seen = 0
    if (Date.now() - t0 > 15_000) throw new Error(`patch never centred on ${cx},${cz}: ${JSON.stringify(b?.ground)}`)
    await page.waitForTimeout(60)
  }
}
const ray = (page: Page, x: number, z: number) => page.evaluate(([px, pz]) => (window as unknown as Hooks).__ysfxGroundRay(px, pz), [x, z])

test('the visitor stands on the heightfield; on a slope it lies where the engine says the ground is', async ({ page }) => {
  test.setTimeout(900_000)
  await watchBeacon(page)
  await page.goto(`http://localhost:5173/?ysfxnet=host:${ROOM}`)
  const first = await waitForBeacon(page, (b) => b.role === 'host' && !!b.net && b.net.ready && !!b.apron && !!b.ground.patch && b.ground.field != null && !!b.ground.feet, 90_000, 'server ready, heightfield laid')
  await page.waitForTimeout(2500)
  const stood = (await lastBeacon(page))!
  console.log(`[terrain] apron: feet ${stood.ground.feet!.map((n) => n.toFixed(2)).join(',')} engine ${stood.ground.field!.toFixed(2)} patch ${JSON.stringify(stood.ground.patch)}`)
  expect(Math.abs(stood.ground.feet![1] - stood.ground.field!)).toBeLessThan(0.1)
  // The collider itself, beside the visitor (not through their own body).
  const beside = await ray(page, stood.ground.feet![0] + 6, stood.ground.feet![2] - 9)
  expect(beside).not.toBeNull()
  expect(Math.abs(beside! - stood.ground.field!)).toBeLessThan(0.1)

  for (const field of FIELDS) {
    if (first.field.current !== field) {
      await page.evaluate((f) => (window as unknown as Hooks).__ysfxSetField(f), field)
      await waitForBeacon(page, (b) => b.field?.current === field && !!b.net && b.net.ready && b.load?.stage === 'ready' && !!b.apron && !!b.ground.patch, 120_000, `field ${field} ready`)
      await page.waitForTimeout(2000)
    }
    const apron = (await lastBeacon(page))!.apron!
    // Look for a slope: rings around the apron, further and further out.
    let found: { x: number; z: number; relief: number } | null = null
    search: for (let r = 400; r <= 16000; r += 400) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2
        const x = apron.spawn[0] + r * Math.cos(a), z = apron.spawn[2] + r * Math.sin(a)
        const p = (await focus(page, x, z)).ground.patch!
        if (p.deckSamples === 0 && p.max - p.min > 4) { found = { x: p.cx, z: p.cz, relief: p.max - p.min }; break search }
      }
    }
    expect(found, `a slope within 16 km of the apron on ${field}`).not.toBeNull()
    console.log(`[terrain] ${field}: slope at ${found!.x},${found!.z} (${Math.hypot(found!.x - apron.spawn[0], found!.z - apron.spawn[2]).toFixed(0)} m from the apron), relief ${found!.relief.toFixed(1)} m over 48 m`)
    let worst = 0
    const rows: string[] = []
    // Off the sample lines: a ray that runs exactly along the edge between two
    // cells can slip between their triangles (seen once at an offset of -19, 6:
    // "no collider", with the same patch answering a centimetre to the side).
    // A body with any width does not have that problem.
    for (const [dx, dz] of [[0.3, 0.4], [3.3, 1.1], [-2.7, 3.9], [11.2, -7.3], [-13.4, -15.1], [17.5, 12.5], [-19.3, 6.4], [-19.01, 6.01], [5.6, 19.2], [1.1, -21.3], [-8.5, -3.5], [21.2, 21.4], [-21.3, 20.6]]) {
      const x = found!.x + dx, z = found!.z + dz
      const b = await focus(page, x, z)
      const hit = await ray(page, x, z)
      if (hit == null) { rows.push(`${dx},${dz}: engine ${b.ground.field!.toFixed(2)} collider MISSING patch ${JSON.stringify(b.ground.patch)}`); worst = Infinity; continue }
      const d = hit - b.ground.field!
      rows.push(`${dx},${dz}: engine ${b.ground.field!.toFixed(2)} collider ${hit.toFixed(2)} (${d >= 0 ? '+' : ''}${d.toFixed(2)})`)
      worst = Math.max(worst, Math.abs(d))
    }
    console.log(`[terrain] ${field}: ${rows.join(' | ')}`)
    console.log(`[terrain] ${field}: worst collider - engine ${worst.toFixed(3)} m`)
    expect(worst).toBeLessThan(0.3)

    // Now with a body: put the visitor on that slope and walk.  The patch is
    // rebuilt under their feet every 8 m; they must stay on the ground the
    // engine reports, never under it.
    const top = (await focus(page, found!.x, found!.z)).ground.field!
    await page.evaluate(() => (window as unknown as Hooks).__ysfxPatchFocus(null, null))
    await page.evaluate(([x, y, z]) => (window as unknown as Hooks).__ysfxApronAt(x, y, z), [found!.x, top, found!.z])
    const landed = await waitForBeacon(page, (b) => !!b.ground.feet && Math.hypot(b.ground.feet[0] - found!.x, b.ground.feet[2] - found!.z) < 3 && b.ground.field != null && Math.abs(b.ground.feet[1] - b.ground.field) < 0.15 && !!b.ground.patch && Math.abs(b.ground.patch.cx - b.ground.feet[0]) <= SNAP, 15_000, 'standing on the slope')
    const builds0 = landed.ground.patch!.builds
    const start = landed.ground.feet!
    let lo = Infinity, hi = -Infinity, yMin = Infinity, yMax = -Infinity, n = 0, lastT = 0
    await page.keyboard.down('w')
    const t0 = Date.now()
    while (Date.now() - t0 < 12_000) {
      const b = await lastBeacon(page)
      if (b && b.t !== lastT && b.ground.feet && b.ground.field != null) {
        lastT = b.t
        const d = b.ground.feet[1] - b.ground.field
        lo = Math.min(lo, d); hi = Math.max(hi, d); yMin = Math.min(yMin, b.ground.feet[1]); yMax = Math.max(yMax, b.ground.feet[1]); n++
      }
      await page.waitForTimeout(40)
    }
    await page.keyboard.up('w')
    await page.waitForTimeout(1500)
    const end = (await lastBeacon(page))!
    const walked = Math.hypot(end.ground.feet![0] - start[0], end.ground.feet![2] - start[2])
    console.log(`[terrain] ${field}: walked ${walked.toFixed(1)} m, height ${yMin.toFixed(2)}..${yMax.toFixed(2)} m, feet - engine ground while walking ${lo.toFixed(2)}..${hi >= 0 ? '+' : ''}${hi.toFixed(2)} m over ${n} samples, at rest ${(end.ground.feet![1] - end.ground.field!).toFixed(3)} m, patch rebuilt ${end.ground.patch!.builds - builds0} times`)
    expect(walked).toBeGreaterThan(20)
    expect(yMax - yMin).toBeGreaterThan(0.3) // it really was a slope
    expect(end.ground.patch!.builds - builds0).toBeGreaterThanOrEqual(2)
    expect(lo).toBeGreaterThan(-0.3)
    expect(Math.abs(end.ground.feet![1] - end.ground.field!)).toBeLessThan(0.15)
  }
  await page.evaluate(() => (window as unknown as Hooks).__ysfxPatchFocus(null, null))
})
