# tests — PC / SP / VR harness

| project | target | what it drives |
|---|---|---|
| `local-pc` | XRift dev environment (vite) + local signaling + engine files, all started by Playwright | keyboard; sitting via the dev-only `window.__ysfxSit` hook |
| `prod-pc` | app.xrift.net, desktop Chrome | the real host UI |
| `prod-sp` | app.xrift.net, Pixel 7 profile (touch, mobile UA) | the real host's mobile UI |
| `prod-vr` | app.xrift.net inside an emulated immersive-vr session (playwright-webxr / IWER) | the real host's VR interaction: controller ray + trigger on a seat, thumbstick |

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

`tests/.auth/xrift.json` holds the logged-in session and is gitignored. Two clients on one
machine cannot be made to connect over WebRTC here (see keel: WARP); multi-client runs need
a second machine.
