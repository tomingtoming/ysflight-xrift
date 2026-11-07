# ysflight-xrift

YSFLIGHT (captainys) running inside an [XRift](https://xrift.net) world: the
original engine compiled to WebAssembly draws into the XRift host's three.js
frame, so the airfield, the aircraft and the flight model are the real thing
while avatars, voice and presence stay XRift's.

Status: spike — the engine boots inside the XRift dev environment, draws the
field from the XRift player's camera (per eye in WebXR), and takes keyboard
input.  Seats, multiplayer and the upload are next.

## Layout

```
upstream/YSFLIGHT   fork (tomingtoming/YSFLIGHT), branch xrift = main + fsvr external-view block
upstream/public     fork (tomingtoming/public), main
engine/port/        platform layer for a HOSTED engine (no window, no loop, host GL context)
engine/build.sh     emcmake build -> engine/dist/ysflight32_gl2.{js,wasm,data}
engine/serve.mjs    dev-only static server for engine/dist (Vite cannot import() from public/)
world/              the XRift world (React Three Fiber, @xrift/world-components)
world/src/engine/   YsflightEngine: boots the wasm on the host's WebGL context, steps the
                    simulation from useFrame, draws per camera from a render hook
```

## Build & run

```sh
engine/build.sh                 # needs emcc + cmake
node engine/serve.mjs 5180 &    # dev: serve the engine
cd world && npm install && echo 'VITE_YSFX_ENGINE_URL=http://localhost:5180/' > .env.development
npm run dev                     # http://localhost:5173  (Space = confirm "center joystick", F2 = outside view)
```

Production: `world/scripts-sync-engine.sh` copies `engine/dist` into
`world/public/engine/` and the world loads it from `${baseUrl}engine/`.

## How it fits together

- **Loop**: `YsfxInterval()` once per host frame, `YsfxDraw()` once per camera
  (two per frame in WebXR) from a mesh's `onBeforeRender`.
- **Camera**: the host camera's frustum tangents, view matrix and viewport go
  into the engine's `fsvr` eye block with the external-view flag set
  (`FsVrExternalViewDataPointer`, added on the fork's `xrift` branch), so the
  engine draws from the XRift camera.  Engine GL-world == three.js world
  (engine x,y,z_LH == three x,y,-z).
- **GL**: the engine draws on the host's WebGL2 context (Emscripten
  `GL.registerContext`); after each draw the host gets its state back
  (`renderer.resetState()` + render target/viewport restore).

No dependency on ysflight-web: shared ancestry is the engine forks only.

License: engine and data follow the upstream forks; this repository's own
code is MIT.
