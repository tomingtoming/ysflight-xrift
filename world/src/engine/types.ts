/** Subset of the Emscripten module surface ysflight-xrift uses. */
export interface YsflightModule {
  HEAPF32: Float32Array
  HEAP8: Int8Array
  HEAPU8: Uint8Array
  ccall: (name: string, ret: string | null, argTypes: string[], args: unknown[]) => unknown
  cwrap: (name: string, ret: string | null, argTypes: string[]) => (...args: unknown[]) => unknown
  UTF8ToString: (ptr: number) => string
  // fsvr.h
  _FsVrSetActive: (active: number) => void
  _FsVrIsActive: () => number
  _FsVrEyeDataPointer: (eye: number) => number
  _FsVrExternalViewDataPointer: () => number
  _FsVrPlayerPoseDataPointer: () => number
  _FsVrControlDataPointer: () => number
  _FsVrHandPoseDataPointer: () => number
  _FsVrAircraftStateDataPointer: () => number
  _FsVrConsumeSimDrawnFrames: () => number
  _FsVrPerfDataPointer: () => number
  // fsvr.h network-lobby automation (ysflight-xrift fork)
  _FsVrNetRequestLeave: () => void
  _FsVrNetStateDataPointer: () => number
  _FsVrAirListDataPointer: () => number
  _FsVrAirListIdentifier: (i: number) => number
  _FsVrAirListName: (i: number) => number
  // port layer (Ysfx*)
  _YsfxInterval: () => void
  _YsfxDraw: () => number
  _YsfxTerminated: () => number
  _YsfxGetIntervalMs: () => number
  _YsfxGetDrawMs: () => number
  _YsfxChar: (c: number) => void
  _YsfxReleaseAllKeys: () => void
  _YsfxMouse: (eventType: number, lb: number, mb: number, rb: number, mx: number, my: number) => void
  _YsfxSetWindowSize: (w: number, h: number) => void
  FS: {
    mkdirTree: (path: string) => void
    writeFile: (path: string, data: string | Uint8Array) => void
    analyzePath: (path: string) => { exists: boolean }
  }
}

export interface YsflightModuleOptions {
  canvas: HTMLCanvasElement
  preinitializedWebGLContext: WebGL2RenderingContext
  locateFile: (path: string) => string
  arguments: string[]
  print?: (s: string) => void
  printErr?: (s: string) => void
  onAbort?: (what: unknown) => void
  preRun?: Array<() => void>
  /** yssocket_emscripten: signaling WebSocket URL (wss://.../signal). */
  ysfwSignalUrl?: string
  /** yssocket_emscripten: room code to register when hosting (-server). */
  ysfwRoomCode?: string
  /** yssocket_emscripten: ICE servers; STUN-only fallback when absent. */
  ysfwIceServers?: Array<{ urls: string | string[] }>
}

export type CreateYsflight = (opts: YsflightModuleOptions) => Promise<YsflightModule>
