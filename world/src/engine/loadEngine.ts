import type { CreateYsflight, YsflightModule, YsflightModuleOptions } from './types'

const GLUE = 'ysflight32_gl2.js'

/** Where the engine files live.  Production: `${baseUrl}engine/` (the files
    are in public/engine/).  Development: Vite refuses to import() from
    public/, so `.env.development` points at engine/serve.mjs instead. */

/** <userdir>/config/ctlassign.cfg with the keyboard as the stick (see preRun). */
const CTL_ASSIGN_KEYBOARD =
  [
    'VER 20181124',
    'KEY UP ELEVATORDOWN',
    'KEY DOWN ELEVATORUP',
    'KEY LEFT AILERONLEFT',
    'KEY RIGHT AILERONRIGHT',
    'KEY INS TRIMDOWN',
    'KEY DEL TRIMUP',
    'KEY T AUTOTRIM',
    'KEY Q THROTTLEUP',
    'KEY A THROTTLEDOWN',
    'KEY TAB AFTERBURNER',
    'KEY PAGEUP NOZZLEUP',
    'KEY PAGEDOWN NOZZLEDOWN',
    'KEY COMMA CYCLESENSITIVITY',
    'KEY G LANDINGGEAR',
    'KEY B SPOILERBRAKE',
    'KEY Z RUDDERLEFT',
    'KEY X RUDDERCENTER',
    'KEY C RUDDERRIGHT',
    'KEY SPACE FIREWEAPON',
    'KEY 2 SELECTWEAPON',
    'KEY P CYCLESMOKESELECTOR',
    'KEY 3 RADAR',
    'KEY 4 DISPENSEFLARE',
    'KEY I TOGGLELIGHT',
    'KEY V VELOCITYINDICATOR',
    'KEY BS OPENAUTOPILOTMENU',
    'KEY ENTER OPENRADIOCOMMMENU',
    'KEY F1 COCKPITVIEW',
    'KEY F2 OUTSIDEPLAYERVIEW',
    'KEY F3 COMPUTERAIRPLANEVIEW',
    'KEY F4 WEAPONVIEW',
    'KEY F5 CHANGEAIRPLANE',
    'KEY F6 ILSVIEW',
    'KEY F7 OUTSIDEPLAYERVIEW2',
    'KEY F8 CONTROLTOWERVIEW',
    'KEY F9 SWITCHVIEWTARGET',
    'KEY U LOOKFORWARD',
    'KEY K LOOKRIGHT',
    'KEY H LOOKLEFT',
    'KEY M LOOKBACK',
    'KEY J LOOKUP',
    'KEY N LOOKDOWN',
    'KEY DOT REVERSETHRUST',
    'KEY W PROPFORWARD',
    'KEY S PROPBACKWARD',
    'KEY R FLAPUP',
    'KEY F FLAPDOWN',
    'KEY O OPENSUBWINDOWMENU',
    'KEY 9 CHANGEHUDCOLOR',
    'KEY PAUSEBREAK PAUSESIMULATION',
    'KEY F10 GHOSTVIEW',
    'KEY L OPENVORMENU',
    'KEY 7 ROTATEVORLEFT',
    'KEY 8 ROTATEVORRIGHT',
    'KEY 1 BOMBBAYDOOR',
    'KEY CTRL INFLIGHTCFG',
    'KEY SEMICOLON TOGGLEALLDOOR',
    'KEY F12 INFLTMESSAGE',
    'KEY HOME OPENSUPPLYDLG',
    'DZELV2 0.000',
    'DZAIL2 0.030',
    'DZRUD2 0.030',
    'HATSW TRUE',
    'END',
  ].join('\n') + '\n'

export function engineBase(baseUrl: string): string {
  const dev = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_YSFX_ENGINE_URL
  return dev || `${baseUrl}engine/`
}

let gluePromise: Promise<CreateYsflight> | null = null

/** Loads the Emscripten glue once (as its own module, not inlined into the
    world chunk) and returns the factory. */
export function loadGlue(baseUrl: string): Promise<CreateYsflight> {
  if (!gluePromise) {
    const url = `${engineBase(baseUrl)}${GLUE}`
    gluePromise = import(/* @vite-ignore */ url).then((m) => m.default as CreateYsflight)
  }
  return gluePromise
}

export async function createEngine(
  baseUrl: string,
  opts: Omit<YsflightModuleOptions, 'locateFile'>,
): Promise<YsflightModule> {
  const create = await loadGlue(baseUrl)
  const moduleOpts: YsflightModuleOptions & Partial<YsflightModule> = {
    ...opts,
    locateFile: (path: string) => `${engineBase(baseUrl)}${path}`,
  }
  moduleOpts.preRun = [
    () => {
      // The engine shows a first-launch dialog unless <common dir>/<VERSION>
      // exists (fsmain.cpp case 5 / FsGetFirstStartFile).  Nothing persists
      // in the host, so mark it every boot.  Dir = FsGetCommonYsflightDir().
      const FS = moduleOpts.FS!
      const dir = '/home/web_user/Documents/YSFLIGHT.COM/YSFLIGHT'
      FS.mkdirTree(dir)
      FS.writeFile(`${dir}/20181124`, 'xrift')
      FS.mkdirTree(`${dir}/config`)
      // No joystick in the host: skip the "joystick unplugged" warning dialog
      // (FsSimulation::NeedNoJoystickWarningDialog reads flight.cfg JSWARNING).
      FS.writeFile(`${dir}/config/flight.cfg`, 'JSWARNING FALSE\n')
      // Control assignment: keyboard as the stick.  Without this file the
      // engine's default puts aileron/elevator on joystick 0, finds no such
      // axis, and silently rebinds them to the MOUSE (fscontrol.cpp
      // VerifyAndFixJoystickAxisAssignment) -- which the host never feeds, so
      // the stick sat hard over (observed on the production host 11-08).
      // Format: FsControlAssignment::Load.  Keyboard table = SetDefaultKeyAssign
      // + SetDefaultKeyboardAsStick.  SPACE/FIREWEAPON is listed but never
      // reaches the engine (the host reserves Space); fire key still open.
      FS.writeFile(`${dir}/config/ctlassign.cfg`, CTL_ASSIGN_KEYBOARD)
    },
  ]
  const m = await create(moduleOpts)
  // The shared-memory layout this world was written against (fsvr.h
  // FSVR_ABI_VERSION).  A stale engine binary next to a newer world would
  // otherwise run and misread floats.
  const abi = m._FsVrAbiVersion?.() ?? 0
  if (abi !== ENGINE_ABI) throw new Error(`engine ABI ${abi}, world expects ${ENGINE_ABI}: rebuild the engine (engine/build.sh)`)
  import(/* @vite-ignore */ `${engineBase(baseUrl)}build.js`).then((mod: { default?: { fork?: string; built?: string } }) => {
    const b = mod.default ?? {}
    engineBuild = `${b.fork ?? '?'} ${b.built ?? ''}`.trim()
    console.log('[ysf] engine build', engineBuild)
  }).catch(() => { /* no build stamp: an engine installed by hand */ })
  return m
}

/** fsvr.h FSVR_ABI_VERSION this world is written against. */
export const ENGINE_ABI = 5
let engineBuild: string | null = null
/** The fork commit the running engine binary was built from (engine/build.sh), once known. */
export function engineBuildId(): string | null { return engineBuild }
