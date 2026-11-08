/**
 * ysflight-xrift test harness.
 *
 * Targets
 *   local-pc : the XRift dev environment (vite) + local signaling + engine
 *              files, all started by Playwright.  PC input only (the dev
 *              environment has no touch or WebXR); sitting goes through the
 *              dev-only window.__ysfxSit hook.
 *   prod-pc  : the real XRift host (app.xrift.net), desktop Chromium.
 *   prod-sp  : the real host with a phone profile (touch, mobile UA).
 *   prod-vr  : the real host inside an emulated immersive-vr session
 *              (playwright-webxr / IWER): the host's own VR interaction is
 *              exercised -- controller ray to a seat, trigger, thumbstick.
 * prod-* need a logged-in storage state: `npm run test:auth` once (gitignored).
 */
import { defineConfig, devices } from '@playwright/test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const AUTH = resolve(__dirname, '.auth/xrift.json')
export const WORLD_URL = process.env.YSFX_WORLD_URL || 'https://app.xrift.net/world/a172ce51-3601-45ec-8a64-6af6a8b53cfb'
export const HAS_AUTH = existsSync(AUTH)

export default defineConfig({
  testDir: __dirname,
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: [['line'], ['html', { open: 'never', outputFolder: resolve(__dirname, '../playwright-report') }]],
  outputDir: resolve(__dirname, '../test-results'),
  use: {
    channel: 'chrome',
    headless: process.env.YSFX_HEADED ? false : true,
    locale: 'ja-JP',
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'local-pc', testMatch: /local-.*\.spec\.ts/ },
    { name: 'prod-pc', testMatch: /prod-pc\.spec\.ts/, use: { storageState: AUTH } },
    { name: 'prod-sp', testMatch: /prod-sp\.spec\.ts/, use: { ...devices['Pixel 7'], channel: 'chrome', storageState: AUTH } },
    { name: 'prod-vr', testMatch: /prod-vr\.spec\.ts/, use: { storageState: AUTH } },
  ],
  webServer: process.env.YSFX_NO_SERVERS
    ? undefined
    : [
        { command: 'node engine/serve.mjs 5180', cwd: resolve(__dirname, '../..'), url: 'http://localhost:5180/ysflight32_gl2.js', reuseExistingServer: true, timeout: 30_000, stdout: 'pipe', stderr: 'pipe' },
        { command: 'npx wrangler dev --port 8787 --local', cwd: resolve(__dirname, '../../signal'), url: 'http://localhost:8787/healthz', reuseExistingServer: true, timeout: 90_000, stdout: 'pipe', stderr: 'pipe' },
        { command: 'npx vite --port 5173 --strictPort', cwd: resolve(__dirname, '..'), url: 'http://localhost:5173/', reuseExistingServer: true, timeout: 90_000, stdout: 'pipe', stderr: 'pipe' },
      ],
})
