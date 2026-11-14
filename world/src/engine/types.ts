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
  _FsVrPlayerVisualDataPointer: () => number
  _FsVrSetFrameTimeMs: (ms: number) => void
  _FsVrAbiVersion?: () => number
  /** Emscripten's OpenAL state: one Web Audio context per AL context. */
  AL?: { contexts?: Record<string, { audioCtx?: AudioContext } | null> }
  _FsVrControlDataPointer: () => number
  _FsVrHandPoseDataPointer: () => number
  _FsVrAircraftStateDataPointer: () => number
  _FsVrConsumeSimDrawnFrames: () => number
  _FsVrPerfDataPointer: () => number
  /** Heap gauge (fsvr.h): [heap MB, malloc'd MB, free MB, samples]; absent in engine binaries built before it. */
  _FsVrMemDataPointer?: () => number
  _FsVrMemSample?: () => void
  // fsvr.h network-lobby automation (ysflight-xrift fork)
  _FsVrNetRequestLeave: () => void
  _FsVrNetStateDataPointer: () => number
  _FsVrAirListDataPointer: () => number
  _FsVrAirListIdentifier: (i: number) => number
  _FsVrAirListName: (i: number) => number
  _FsVrFlightDataPointer: () => number
  _FsVrHudDataPointer: () => number
  _FsVrGroundProbeDataPointer: () => number
  /** Ground grid block (fsvr.h): request [0..4], answer [5..7], n*n heights from [8]. */
  _FsVrGroundGridDataPointer: () => number
  /** Loadout editor block and its two calls (fsvr.h). */
  _FsVrLoadoutDataPointer: () => number
  _FsVrLoadoutChange: (wpnType: number, n: number) => void
  /** Showroom preview block (fsvr.h): enable, position xyz (world), heading, [5] template radius (engine). */
  _FsVrPreviewDataPointer: () => number
  /** Lobby commands beyond join/leave (fsvr.h): reports, missions, revive ground. */
  _FsVrNetRequestCommand: (cmd: number) => void
  /** Engine console text: lines ever printed, and line `back` lines before the newest (char*). */
  _FsVrConsoleSeq: () => number
  _FsVrConsoleLine: (back: number) => number
  _FsVrLobbyAirCount: () => number
  _FsVrLobbyAirName: (i: number) => number
  _FsVrLobbyStpCount: () => number
  _FsVrLobbyStpName: (i: number) => number
  _FsVrLobbyStpPos: (i: number) => number
  _FsVrLobbyStpHeading: (i: number) => number
  _FsVrLobbyFieldCount: () => number
  _FsVrLobbyFieldName: (i: number) => number
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
  setStatus?: (text: string) => void
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
