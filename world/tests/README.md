# tests — PC / SP / VR harness

| project | target | what it drives |
|---|---|---|
| `local-pc` | XRift dev environment (vite) + local signaling + engine files, all started by Playwright | keyboard; sitting via the dev-only `window.__ysfxSit` hook |
| `prod-pc` | app.xrift.net, desktop Chrome | the real host UI |
| `prod-sp` | app.xrift.net, Pixel 7 profile (touch, mobile UA) | the real host's mobile UI: virtual stick, interact tap on the kiosk and on the switch panel (BRK toggles the brake, THR＋ ×3 = 30 %), jump held to leave |
| `prod-vr` | app.xrift.net inside an emulated immersive-vr session (playwright-webxr / IWER) | the real host's VR interaction: controller ray + trigger on a seat; the world's SaccFlight-style hands (`xr.hold('right','squeeze')` + `setGripPose` rotations → stick, left grip push → throttle, `setAxes` dial + trigger → brake toggle); eye calibration residual; target-ray pointer + short trigger on the kiosk's uikit button; A held to leave |
| `prod-multi` | app.xrift.net, two contexts: the logged-in account (host) + a guest (client) | host election, WebRTC client connection, kiosk flights both ways, each side's aircraft list shows the other |

Observation channel: the world dispatches a `ysfx-state` CustomEvent on `window` twice a second
(`src/net/StateBeacon.tsx`: role, room, engine session state, flight data, aircraft list, HUD lines).
No globals are written, so it passes XRift's code-security check and ships in production.

```sh
npm run test:local                 # dev environment, PC
npm run test:auth                  # once: log in to XRift in the opened browser, then close it
npm run test:prod                  # real host: pc, sp, vr
YSFX_HEADED=1 npm run test:local   # watch it
```

prod-* enter the world through the host's lobby (`helpers.ts: enterWorld`): world page -> first
instance card (or "新規作成") -> "入室する", with a fake microphone granted. `YSFX_INSTANCE_URL`
skips the lobby. Entering takes ~10 s on a desktop profile.

`tests/.auth/xrift.json` holds the logged-in session and is gitignored. `prod-multi` needs
local WebRTC P2P, which Cloudflare WARP on this Mac breaks: run it with WARP off. The second
pilot must be a guest (the host drops an earlier connection of the same account), and
`browser.newContext()` inherits the project's `storageState` unless overridden with `undefined`.

## Linux hosts: headless Chrome needs the real GPU

Headless Chrome falls back to SwiftShader (software WebGL) by default; the
engine does not boot on it (`boot failed ... setting 'enabled'`, every test
times out at "server ready").  On toming-server (AMD 780M, RADV):

    YSFX_ARGS="--enable-gpu --use-angle=vulkan --enable-features=Vulkan" npm run test:local

Engine builds there: `source ~/emsdk/emsdk_env.sh` (Emscripten 7.0.0) and
cmake from `~/.local/bin` before `engine/build.sh` (2026-11-12).
