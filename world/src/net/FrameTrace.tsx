/**
 * FrameTrace — a frame-by-frame record of where the simulation has the
 * player's aircraft, where the host has the camera and where it has the
 * body, taken at render time (after every host callback of the frame).
 *
 * The beacon is 10 Hz and the lag report is an average: neither shows what a
 * pilot on a 120 Hz display sees.  `window.__ysfxTrace = 600` records the
 * next 600 rendered frames into `window.__ysfxTraceData`.
 */
import { useEffect, useRef } from 'react'
import { useUsers } from '@xrift/world-components'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { onBeforeEngineDraw, useEngine } from '../engine/engineStore'
import { frameClock } from '../engine/frameClock'
import { airBase, airCount } from './netState'
import { readFeetAtRender } from './seatLead'

type W = { __ysfxTrace?: number; __ysfxTraceData?: number[][] }

export function FrameTrace() {
  const mod = useEngine()
  const users = useUsers()
  const feet = useRef(new Vector3())
  const cam = useRef(new Vector3())
  const tmp = useRef({ m: new Matrix4(), qa: new Quaternion(), qc: new Quaternion(), p: new Vector3(), s: new Vector3() })
  useEffect(() => {
    if (!mod) return
    const w = window as unknown as W
    let rows: number[][] | null = null
    let lastFrame = -1
    return onBeforeEngineDraw((camera) => {
      if (w.__ysfxTrace && w.__ysfxTrace > 0 && !rows) { rows = []; w.__ysfxTraceData = undefined }
      if (!rows || frameClock.frame === lastFrame) return // once per frame (XR draws per eye)
      lastFrame = frameClock.frame
      const f = mod.HEAPF32
      let a = [NaN, NaN, NaN]
      const t = tmp.current
      t.qa.identity()
      for (let i = 0, n = airCount(mod); i < n; i++) {
        const b = airBase(mod, i)
        if (f[b + 2] !== 0) { a = [f[b + 3 + 12], f[b + 3 + 13], f[b + 3 + 14]]; t.m.fromArray(f, b + 3).decompose(t.p, t.qa, t.s); break }
      }
      cam.current.setFromMatrixPosition(camera.matrixWorld)
      const p = readFeetAtRender(users, feet.current)
      // The camera's attitude in the aircraft frame: constant while the pilot does not look around.
      camera.matrixWorld.decompose(t.p, t.qc, t.s)
      t.qc.premultiply(t.qa.clone().invert())
      rows.push([frameClock.nowMs, performance.now(), a[0], a[1], a[2], cam.current.x, cam.current.y, cam.current.z, p ? p.x : NaN, p ? p.y : NaN, p ? p.z : NaN, t.qc.x, t.qc.y, t.qc.z, t.qc.w, t.qa.x, t.qa.y, t.qa.z, t.qa.w])
      if (rows.length >= (w.__ysfxTrace ?? 0)) { w.__ysfxTraceData = rows; rows = null; w.__ysfxTrace = 0 }
    })
  }, [mod, users])
  return null
}
