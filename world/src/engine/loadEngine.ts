import type { CreateYsflight, YsflightModule, YsflightModuleOptions } from './types'

const GLUE = 'ysflight32_gl2.js'

/** Where the engine files live.  Production: `${baseUrl}engine/` (the files
    are in public/engine/).  Development: Vite refuses to import() from
    public/, so `.env.development` points at engine/serve.mjs instead. */
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
    },
  ]
  return create(moduleOpts)
}
