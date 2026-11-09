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

## Controls

Desktop: hold the left mouse button and the mouse is the stick (its travel
since the grab is the deflection, 250 px = full; release and it springs back
to centre; the mouse is the look again).  The box at the lower left of the HUD
glass shows the stick (dot) and rudder (bar), in place of YSFLIGHT's virtual
joystick model, which the external-view host does not draw.  Keys reach the engine while seated (YSFLIGHT defaults: arrows or
W/S for the stick, Q/A throttle, Z/X/C rudder, G gear, B brake, F/R flaps,
Tab afterburner, Space gun); A/D are taken out of the host's seat roll axis
so A only throttles down.  Space held stands up.

In VR the hands fly the aircraft SaccFlight-style (`world/src/vr/`):

| Input | Function |
|---|---|
| right grip squeeze | take the stick; wrist pitch / roll / twist since the grab = elevator / aileron / rudder (45° = full) |
| left grip squeeze | take the throttle; push forward 17 cm = idle → full; shove 3 cm past the stop = afterburner on, pull back below 95 % = off |
| double squeeze (either grip) | sticky grab: keeps the control without holding the grip; the next squeeze + release lets go |
| thumbstick (either hand) | pick one of six functions on that hand's dial (shown above the controller); the pick sticks after recentring |
| trigger (either hand) | fire the picked function. Right dial: Gun, 武器切替, フレア, Gear, Brake, レーダー. Left dial: Flap↑, Smoke, A/B, Flap↓, トリム, Brake |
| right B | brake / spoiler toggle |
| right A | stand up (host) |

Left X (mic), left Y (dashboard) and the right thumbstick's turning while seated
belong to the XRift host and are left alone.

On a phone the virtual stick flies and a switch panel below the HUD carries the
rest (`world/src/net/TouchConsole.tsx`): look at a button and tap インタラクト.
THR−/THR＋ step the throttle 10 %, A/B, GEAR, BRK, FLP DN/UP tap the engine
keys, FIRE holds the gun for half a second; each button shows its live state.
The panel appears on coarse-pointer devices only.

Standing up leaves the aircraft where it is, throttle idle and brake on, with its
exterior drawn; walk back and click the cockpit to board it again.  飛行開始 at
the kiosk replaces a parked aircraft with the new one.

Seats put the pilot's eye on the engine's cockpit point: 1.0 s after sitting the
seat measures the camera relative to its origin for 0.5 s and moves the hip
point so the eye lands there (`world/src/net/seatEye.ts`), for any avatar
height and for a real headset.  The HUD glass and the gunsight follow the
measured eye.

No dependency on ysflight-web: shared ancestry is the engine forks only.

License: engine and data follow the upstream forks; this repository's own
code is MIT.
