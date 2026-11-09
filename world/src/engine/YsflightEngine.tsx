/**
 * YsflightEngine — runs the YSFLIGHT engine (WebAssembly) inside the host's
 * three.js frame.
 *
 *  - Simulation: one YsfxInterval() per host frame (useFrame).
 *  - Drawing: a hook mesh whose onBeforeRender fires once per camera
 *    (per eye in WebXR).  Before each engine draw we publish that camera's
 *    frustum, view matrix and viewport into the engine's fsvr eye block
 *    (external-view mode), redirect the engine's default-framebuffer binds to
 *    whatever the host has bound, and afterwards hand the GL state back to
 *    three.js (resetState + re-bind the render target and viewport).
 *
 * Coordinates: the engine's GL-convention world IS the three.js world
 * (engine x,y,z_LH  <->  three x,y,-z).
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useXRift } from '@xrift/world-components'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BoxGeometry, Camera, Mesh, MeshBasicMaterial, Vector2, Vector4, WebGLRenderer } from 'three'
import { createEngine } from './loadEngine'
import { isPiloting, setEngine, setHudTexture } from './engineStore'
import { createHudTarget, type HudTarget } from './hudTarget'
import { subscribeKeys } from './keyBridge'
import type { YsflightModule } from './types'

export interface YsflightEngineProps {
  /** Engine argv, e.g. ['-freeflight','F-16C_FIGHTINGFALCON','ATSUGI_AIRBASE','RW01_01'] */
  args: string[]
  /** Forward window keyboard events to the engine (default true). */
  keyboard?: boolean
  /** Signaling WebSocket URL for -server / -client sessions. */
  signalUrl?: string
  /** Room code to register when hosting (-server). */
  roomCode?: string
  onReady?: () => void
}


export function YsflightEngine({ args, keyboard = true, signalUrl, roomCode, onReady }: YsflightEngineProps) {
  const { gl } = useThree()
  const { baseUrl } = useXRift()
  const [mod, setMod] = useState<YsflightModule | null>(null)
  const modRef = useRef<YsflightModule | null>(null)
  const sizeRef = useRef(new Vector2())
  const hudRef = useRef<HudTarget | null>(null)

  // ---- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false
    const ctx = gl.getContext() as WebGL2RenderingContext
    createEngine(baseUrl, {
      canvas: gl.domElement,
      preinitializedWebGLContext: ctx,
      arguments: args,
      ysfwSignalUrl: signalUrl,
      ysfwRoomCode: roomCode,
      print: (s) => console.log('[ysf]', s),
      printErr: (s) => console.warn('[ysf]', s),
      onAbort: (w) => console.error('[ysf] abort', w),
    })
      .then((m) => {
        if (cancelled) return
        // The engine's init ran on the shared context: give three.js its state back.
        gl.resetState()
        const size = gl.getDrawingBufferSize(sizeRef.current)
        m._YsfxSetWindowSize(size.x, size.y)
        // ?ysfxflat=1 keeps the engine in flat mode (2D menus visible) for debugging.
        const flat = typeof location !== 'undefined' && /[?&]ysfxflat=1/.test(location.search)
        m._FsVrSetActive(flat ? 0 : 1)
        const ext = m._FsVrExternalViewDataPointer() >> 2
        m.HEAPF32[ext] = 1 // external (absolute) eye views
        m.HEAPF32[ext + 1] = 0
        // Real HUD: an off-screen target the engine renders its flat HUD into.
        hudRef.current = createHudTarget(m, ctx)
        setHudTexture(hudRef.current?.texture ?? null)
        gl.resetState()
        modRef.current = m
        setMod(m)
        setEngine(m)
        onReady?.()
        if (import.meta.env.DEV) (window as unknown as { __ysfx?: unknown }).__ysfx = m // dev console aid
        console.log('[ysf] engine ready')
      })
      .catch((e) => console.error('[ysf] boot failed', e))
    return () => {
      cancelled = true
      setEngine(null)
      setHudTexture(null)
      hudRef.current?.dispose()
      hudRef.current = null
      teardownRtc() // a restarted engine (host hand-over) must start from a clean socket layer
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    if (!keyboard || !mod) return
    const key = mod.cwrap('YsfxKeyByCode', 'number', ['string', 'number'])
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    // Space is the host's "leave seat" key; never hand it to the engine
    // (default FIREWEAPON) or every exit fires a burst.
    const reserved = (e: KeyboardEvent) => e.code === 'Space'
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !isPiloting() || reserved(e)) return
      const fs = key(e.code, 1) as number
      ysfxStats.keys++
      ysfxStats.lastKey = `${e.code}->${fs}`
      if (fs !== 0 && e.key.length === 1) mod._YsfxChar(e.key.charCodeAt(0))
    }
    const up = (e: KeyboardEvent) => {
      if (isTyping(e.target) || reserved(e)) return
      key(e.code, 0) // always allowed: releases a key pressed before the gate closed
    }
    const blur = () => mod._YsfxReleaseAllKeys()
    return subscribeKeys(down, up, blur)
  }, [mod, keyboard])

  // ---- simulation step ----------------------------------------------------
  const bootFrames = useRef(0)
  useFrame(() => {
    const m = modRef.current
    if (!m) return
    if ((bootFrames.current & 63) === 0) muteRtcOverlay()
    const size = gl.getDrawingBufferSize(sizeRef.current)
    m._YsfxSetWindowSize(size.x, size.y)
    // Start-up choreography: the engine's pre-flight "CENTER JOYSTICK" prompt
    // accepts the VR trigger (control block [7]); hold it for a moment, release,
    // then switch to the outside view so the player's own aircraft is drawn.
    const n = bootFrames.current++
    const ctl = m._FsVrControlDataPointer() >> 2
    if (n < 240) m.HEAPF32[ctl + 7] = n > 60 && n < 150 ? 1 : 0
    if (n === 240) {
      const key = m.cwrap('YsfxKeyByCode', 'number', ['string', 'number'])
      key('F2', 1)
      key('F2', 0)
    }
    m._YsfxInterval()
  }, -3) // before the seats (-2) and the host's camera (-1) / body (0): see net/seatLead.ts

  // ---- background ticks ---------------------------------------------------
  // requestAnimationFrame stops in a hidden tab, and so would the host's
  // frame loop above: a hidden host froze the whole session (clients' join
  // requests were never approved, measured 2026-11-09).  A Worker ticker is
  // what ysflight-web uses, but XRift's code check refuses any timer inside
  // a Blob worker, so this is a plain interval: ~60 Hz when the tab is
  // visible but the frame loop is stalled, 1 Hz when hidden (Chrome's
  // timer throttling; the open WebRTC connection exempts the page from the
  // 1/min intensive throttling).  The engine's server loop tolerates stalls
  // up to 60 s, so 1 Hz keeps the session alive at reduced fidelity.  Draw
  // stays off while hidden (nothing to draw to).
  useEffect(() => {
    if (!mod) return
    const id = setInterval(() => {
      if (!document.hidden || bootFrames.current < 240) return
      ysfxStats.bgTicks++
      mod._YsfxInterval()
    }, 16)
    return () => clearInterval(id)
  }, [mod])

  // ---- draw hook ----------------------------------------------------------
  const hook = useMemo(() => {
    const mesh = new Mesh(
      new BoxGeometry(0.001, 0.001, 0.001),
      new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
    )
    mesh.frustumCulled = false
    mesh.renderOrder = -1e9
    mesh.name = 'ysflight-draw-hook'
    return mesh
  }, [])

  const tmpViewport = useMemo(() => new Vector4(), [])
  useEffect(() => {
    hook.onBeforeRender = (renderer: WebGLRenderer, _scene, camera: Camera) => {
      const m = modRef.current
      if (!m) return
      drawEngine(m, renderer, camera, tmpViewport)
    }
    return () => {
      hook.onBeforeRender = () => {}
    }
  }, [hook, tmpViewport])

  return <primitive object={hook} />
}

let eyeCounter = 0

export const ysfxStats = { draws: 0, bgTicks: 0, lastEye: -1, lastVp: [0, 0, 0, 0] as number[], keys: 0, lastKey: '', cam: [0, 0, 0] as number[], fwd: [0, 0, 0] as number[], tan: [0, 0, 0, 0] as number[], rt: null as null | { w: number; h: number; samples: number }, fb: false, buf: [0, 0] as number[] }
if (import.meta.env.DEV) (window as unknown as { __ysfxStats?: unknown }).__ysfxStats = ysfxStats

function drawEngine(m: YsflightModule, renderer: WebGLRenderer, camera: Camera, vp: Vector4) {
  const gl = renderer.getContext() as WebGL2RenderingContext
  ysfxStats.draws++

  // Viewport: per-eye in XR (camera.viewport, framebuffer pixels, bottom-left),
  // otherwise the whole drawing buffer.
  const camVp = (camera as Camera & { viewport?: Vector4 }).viewport
  if (camVp) {
    vp.copy(camVp)
  } else {
    const s = renderer.getDrawingBufferSize(new Vector2())
    vp.set(0, 0, s.x, s.y)
  }

  // Eye slot: alternate 0/1 per call within a frame (XR gives two cameras);
  // a flat frame always uses eye 0.
  const eye = camVp ? eyeCounter++ & 1 : 0
  if (!camVp) eyeCounter = 0

  const P = camera.projectionMatrix.elements
  const tanL = (1 - P[8]) / P[0]
  const tanR = (1 + P[8]) / P[0]
  const tanU = (1 + P[9]) / P[5]
  const tanD = (1 - P[9]) / P[5]

  const base = m._FsVrEyeDataPointer(eye) >> 2
  const f = m.HEAPF32
  f[base] = tanL
  f[base + 1] = tanR
  f[base + 2] = tanU
  f[base + 3] = tanD
  const V = camera.matrixWorldInverse.elements
  for (let i = 0; i < 16; i++) f[base + 4 + i] = V[i]
  f[base + 20] = vp.x
  f[base + 21] = vp.y
  f[base + 22] = vp.z
  f[base + 23] = vp.w
  const ext = m._FsVrExternalViewDataPointer() >> 2
  f[ext] = 1
  f[ext + 1] = 1 << eye
  ysfxStats.lastEye = eye
  const W = camera.matrixWorld.elements
  ysfxStats.cam = [W[12], W[13], W[14]]
  ysfxStats.fwd = [-W[8], -W[9], -W[10]]
  ysfxStats.tan = [tanL, tanR, tanU, tanD]
  ysfxStats.lastVp = [vp.x, vp.y, vp.z, vp.w]

  // GL hand-over: baseline state the engine relies on, default-framebuffer
  // redirect to the host's current target, default VAO.
  const rt = renderer.getRenderTarget()
  const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
  ysfxStats.rt = rt ? { w: rt.width, h: rt.height, samples: rt.samples } : null
  ysfxStats.fb = fb !== null
  ysfxStats.buf = [gl.drawingBufferWidth, gl.drawingBufferHeight]
  const origBind = gl.bindFramebuffer
  gl.bindFramebuffer = function (target: number, framebuffer: WebGLFramebuffer | null) {
    origBind.call(gl, target, framebuffer === null ? fb : framebuffer)
  }
  gl.bindVertexArray(null)
  gl.colorMask(true, true, true, true)
  gl.depthMask(true)
  gl.stencilMask(0xffffffff)
  gl.disable(gl.SCISSOR_TEST)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  try {
    m._YsfxDraw()
  } finally {
    gl.bindFramebuffer = origBind
    // Give three.js its state back and restore the target/viewport the host
    // was rendering into (resetState unbinds the framebuffer).
    renderer.resetState()
    renderer.setRenderTarget(rt)
    renderer.state.viewport(vp)
  }
}

// ---------------------------------------------------------------------------
// yssocket_emscripten keeps its WebRTC state on globalThis.ysfwRtc (shared by
// every engine instance on the page) and paints a "Room: ..." overlay into the
// document.  Neither belongs on the XRift host page: mute the overlay, and on
// unmount close everything so a new engine instance starts clean.

interface RtcGlobal {
  overlay?: (text: string | null) => void
  host?: {
    stopped?: boolean
    reconnectTimer?: ReturnType<typeof setTimeout> | null
    ping?: ReturnType<typeof setInterval> | null
    ws?: WebSocket | null
    slots?: Record<string, { ch?: RTCDataChannel; pc?: RTCPeerConnection }>
  } | null
  cli?: {
    ping?: ReturnType<typeof setInterval> | null
    connectTimer?: ReturnType<typeof setTimeout> | null
    ch?: RTCDataChannel | null
    pc?: RTCPeerConnection | null
    ws?: WebSocket | null
  } | null
}

function rtcGlobal(): RtcGlobal | undefined {
  return (globalThis as unknown as { ysfwRtc?: RtcGlobal }).ysfwRtc
}

function muteRtcOverlay(): void {
  const R = rtcGlobal()
  if (!R || R.overlay === noopOverlay) return
  R.overlay = noopOverlay
  document.getElementById('ysfw-room-overlay')?.remove()
}
function noopOverlay(): void {}

function teardownRtc(): void {
  const R = rtcGlobal()
  if (!R) return
  const H = R.host
  if (H) {
    H.stopped = true
    if (H.reconnectTimer) clearTimeout(H.reconnectTimer)
    if (H.ping) clearInterval(H.ping)
    for (const k in H.slots ?? {}) {
      const S = H.slots![k]
      try { S.ch?.close() } catch { /* already closed */ }
      try { S.pc?.close() } catch { /* already closed */ }
    }
    try { H.ws?.close() } catch { /* already closed */ }
    R.host = null
  }
  const C = R.cli
  if (C) {
    if (C.ping) clearInterval(C.ping)
    if (C.connectTimer) clearTimeout(C.connectTimer)
    try { C.ch?.close() } catch { /* already closed */ }
    try { C.pc?.close() } catch { /* already closed */ }
    try { C.ws?.close() } catch { /* already closed */ }
    R.cli = null
  }
  delete (globalThis as unknown as { ysfwRtc?: RtcGlobal }).ysfwRtc
  document.getElementById('ysfw-room-overlay')?.remove()
}
