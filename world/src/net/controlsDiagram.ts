/**
 * controlsDiagram — the controls board as a drawing: a keyboard and a mouse,
 * a gamepad, the two VR controllers and a phone, each with what its keys,
 * sticks and buttons do written on or beside them.
 *
 * Drawn once into a 2D canvas (1 px = 1 mm on the board) that ControlsSign
 * shows as a texture.  Canvas text uses the browser's own fonts, so unlike
 * the uikit panels it can use any glyph.
 *
 * What is written here is a copy of the bindings as implemented --
 * loadEngine.ts (key table), YsflightEngine.tsx (Shift), mouseStick.ts, gamepadStick.ts,
 * vr/saccControls.ts, TouchConsole.tsx.  Change a binding there, change the
 * drawing here.
 */
export const DIAGRAM_W = 2600
export const DIAGRAM_H = 1400

type Ctx = CanvasRenderingContext2D

const BG = '#101418'
const PANEL = '#161c24'
const TITLE = '#a0c8ff'
const TEXT = '#ffffff'
const SUB = '#c8d0d8'
const DIM = '#5a6674'
const KEY_OFF = '#1c232c'
const KEY_OFF_LINE = '#333e4b'
const KEY_ON = '#24456f'
const KEY_ON_LINE = '#6fb0ff'
const LEAD = '#ffb347'
const BODY = '#2a323d'
const BODY_LINE = '#8090a0'
const FONT = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif'

function rr(c: Ctx, x: number, y: number, w: number, h: number, r: number, fill?: string, stroke?: string, lw = 3): void {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
  if (fill) { c.fillStyle = fill; c.fill() }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke() }
}

function disc(c: Ctx, x: number, y: number, r: number, fill?: string, stroke?: string, lw = 3): void {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  if (fill) { c.fillStyle = fill; c.fill() }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke() }
}

function text(c: Ctx, s: string, x: number, y: number, size: number, color = TEXT, align: CanvasTextAlign = 'left', bold = false): void {
  c.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`
  c.fillStyle = color
  c.textAlign = align
  c.textBaseline = 'middle'
  c.fillText(s, x, y)
}

/** A leader line from a part to its label, with a dot on the part. */
function lead(c: Ctx, x1: number, y1: number, x2: number, y2: number): void {
  c.strokeStyle = LEAD
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(x1, y1)
  c.lineTo(x2, y2)
  c.stroke()
  disc(c, x1, y1, 6, LEAD)
}

/** A label: the control's name, and under it what it does (one or two lines). */
function tag(c: Ctx, x: number, y: number, name: string, does: string[], align: CanvasTextAlign = 'left'): void {
  text(c, name, x, y, 32, TEXT, align, true)
  does.forEach((d, i) => text(c, d, x, y + 38 + i * 34, 28, SUB, align))
}

function panel(c: Ctx, x: number, y: number, w: number, h: number, title: string): void {
  rr(c, x, y, w, h, 22, PANEL)
  text(c, title, x + 30, y + 46, 50, TITLE, 'left', true)
}

// ---- PC: keyboard and mouse -------------------------------------------------
function keycap(c: Ctx, x: number, y: number, w: number, h: number, cap: string, does?: string[]): void {
  rr(c, x, y, w, h, 12, does ? KEY_ON : KEY_OFF, does ? KEY_ON_LINE : KEY_OFF_LINE)
  if (!does) { text(c, cap, x + w / 2, y + h / 2, 30, DIM, 'center'); return }
  text(c, cap, x + w / 2, y + 26, 32, TEXT, 'center', true)
  does.forEach((d, i) => text(c, d, x + w / 2, y + 62 + i * 26, 21, SUB, 'center'))
}

function drawPc(c: Ctx, x0: number, y0: number): void {
  panel(c, x0, y0, 1420, 720, 'PC  キーボードとマウス')
  const P = 124, K = 114 // pitch, key size
  const kx = x0 + 40, ky = y0 + 100
  const row = (r: number, startUnits: number, keys: Array<[string, string[]?]>) => {
    keys.forEach(([cap, does], i) => keycap(c, kx + (startUnits + i) * P, ky + r * P, K, K, cap, does))
  }
  // number row (the key left of 1 is not drawn)
  row(0, 1, [['1'], ['2', ['武器', '切替']], ['3', ['レーダー']], ['4', ['フレア']], ['5']])
  keycap(c, kx, ky + P, 1.5 * P - 10, K, 'Tab', ['アフター', 'バーナー'])
  row(1, 1.5, [['Q', ['スロットル', '上げ']], ['W'], ['E'], ['R', ['フラップ', '上げ']], ['T']])
  keycap(c, kx, ky + 2 * P, 1.75 * P - 10, K, 'Caps')
  row(2, 1.75, [['A', ['スロットル', '下げ']], ['S'], ['D'], ['F', ['フラップ', '下げ']], ['G', ['脚']]])
  keycap(c, kx, ky + 3 * P, 2.25 * P - 10, K, 'Shift', ['射撃'])
  row(3, 2.25, [['Z', ['ラダー', '左']], ['X', ['ラダー', '中央']], ['C', ['ラダー', '右']], ['V'], ['B', ['ブレーキ']]])
  // space bar
  rr(c, kx + 2.25 * P, ky + 4 * P, 5 * P - 10, 84, 12, KEY_ON, KEY_ON_LINE)
  text(c, 'Space 長押し： 降りる', kx + 2.25 * P + (5 * P - 10) / 2, ky + 4 * P + 42, 32, TEXT, 'center', true)

  // arrow keys
  const ax = x0 + 1020, ay = ky + 3 * P - 40
  keycap(c, ax + P, ay, K, K, '↑', ['機首', '下げ'])
  keycap(c, ax, ay + P, K, K, '←', ['左', 'ロール'])
  keycap(c, ax + P, ay + P, K, K, '↓', ['機首', '上げ'])
  keycap(c, ax + 2 * P, ay + P, K, K, '→', ['右', 'ロール'])

  // mouse
  const mx = x0 + 1200, my = y0 + 96
  rr(c, mx, my, 170, 250, 80, BODY, BODY_LINE)
  c.save()
  c.beginPath()
  c.roundRect(mx, my, 170, 250, 80)
  c.clip()
  c.fillStyle = KEY_ON
  c.fillRect(mx, my, 170, 105) // both buttons do something
  c.restore()
  rr(c, mx, my, 170, 250, 80, undefined, BODY_LINE)
  c.strokeStyle = BODY_LINE
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(mx + 85, my); c.lineTo(mx + 85, my + 105)
  c.moveTo(mx, my + 105); c.lineTo(mx + 170, my + 105)
  c.stroke()
  rr(c, mx + 75, my + 30, 20, 46, 10, BODY_LINE)
  // the mouse's travel is the stick: four arrows on its palm
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    c.strokeStyle = LEAD; c.fillStyle = LEAD; c.lineWidth = 5
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke()
    const a = Math.atan2(y2 - y1, x2 - x1)
    c.beginPath()
    c.moveTo(x2 + 14 * Math.cos(a), y2 + 14 * Math.sin(a))
    c.lineTo(x2 + 12 * Math.cos(a + 2.2), y2 + 12 * Math.sin(a + 2.2))
    c.lineTo(x2 + 12 * Math.cos(a - 2.2), y2 + 12 * Math.sin(a - 2.2))
    c.fill()
  }
  const ox = mx + 85, oy = my + 176
  arrow(ox + 12, oy, ox + 44, oy); arrow(ox - 12, oy, ox - 44, oy); arrow(ox, oy + 12, ox, oy + 44); arrow(ox, oy - 12, ox, oy - 44)
  lead(c, mx + 40, my + 50, mx - 38, my + 50)
  tag(c, mx - 50, my + 36, '左ボタンを押している間', ['マウスの動きが', 'ピッチ / ロール'], 'right')
  text(c, '離すと中立に戻る', mx - 50, my + 36 + 38 + 2 * 34 + 8, 26, DIM, 'right')
  lead(c, mx + 130, my + 60, mx + 130, my - 30)
  text(c, '右ボタン： 射撃', mx + 196, my - 46, 30, TEXT, 'right', true)
}

// ---- gamepad ----------------------------------------------------------------
function drawPad(c: Ctx, x0: number, y0: number): void {
  panel(c, x0, y0, 1100, 720, 'ゲームパッド')
  const cx = x0 + 550, cy = y0 + 350
  // triggers and bumpers (behind the body)
  rr(c, cx - 200, cy - 196, 120, 60, 16, KEY_ON, KEY_ON_LINE) // LT
  rr(c, cx + 80, cy - 196, 120, 60, 16, KEY_ON, KEY_ON_LINE) // RT
  rr(c, cx - 215, cy - 150, 150, 44, 14, KEY_ON, KEY_ON_LINE) // LB
  rr(c, cx + 65, cy - 150, 150, 44, 14, KEY_ON, KEY_ON_LINE) // RB
  // body: two grips and a bridge
  c.fillStyle = BODY
  c.strokeStyle = BODY_LINE
  c.lineWidth = 3
  c.beginPath()
  c.moveTo(cx - 190, cy - 120)
  c.lineTo(cx + 190, cy - 120)
  c.bezierCurveTo(cx + 270, cy - 120, cx + 300, cy + 60, cx + 290, cy + 150)
  c.bezierCurveTo(cx + 284, cy + 210, cx + 210, cy + 210, cx + 180, cy + 150)
  c.bezierCurveTo(cx + 160, cy + 110, cx + 130, cy + 100, cx + 100, cy + 100)
  c.lineTo(cx - 100, cy + 100)
  c.bezierCurveTo(cx - 130, cy + 100, cx - 160, cy + 110, cx - 180, cy + 150)
  c.bezierCurveTo(cx - 210, cy + 210, cx - 284, cy + 210, cx - 290, cy + 150)
  c.bezierCurveTo(cx - 300, cy + 60, cx - 270, cy - 120, cx - 190, cy - 120)
  c.closePath()
  c.fill()
  c.stroke()
  text(c, 'LT', cx - 140, cy - 172, 24, TEXT, 'center', true)
  text(c, 'RT', cx + 140, cy - 172, 24, TEXT, 'center', true)
  text(c, 'LB', cx - 140, cy - 136, 22, TEXT, 'center', true)
  text(c, 'RB', cx + 140, cy - 136, 22, TEXT, 'center', true)
  // left stick, d-pad, right stick
  const ls = [cx - 165, cy - 45], dp = [cx - 75, cy + 40], rs = [cx + 75, cy + 40]
  disc(c, ls[0], ls[1], 46, KEY_OFF, BODY_LINE); disc(c, ls[0], ls[1], 30, KEY_ON, KEY_ON_LINE)
  disc(c, rs[0], rs[1], 46, KEY_OFF, BODY_LINE); disc(c, rs[0], rs[1], 30, KEY_ON, KEY_ON_LINE)
  rr(c, dp[0] - 16, dp[1] - 46, 32, 92, 6, KEY_ON, KEY_ON_LINE)
  rr(c, dp[0] - 46, dp[1] - 16, 92, 32, 6, KEY_ON, KEY_ON_LINE)
  rr(c, dp[0] - 14, dp[1] - 14, 28, 28, 0, KEY_ON)
  // face buttons, in the usual colours
  const fb = [cx + 165, cy - 45]
  const face: Array<[string, number, number, string]> = [['A', 0, 36, '#5fc86a'], ['B', 36, 0, '#e8615a'], ['X', -36, 0, '#5a9be8'], ['Y', 0, -36, '#e8c85a']]
  for (const [n, dx, dy, col] of face) { disc(c, fb[0] + dx, fb[1] + dy, 20, col); text(c, n, fb[0] + dx, fb[1] + dy + 1, 22, '#101418', 'center', true) }

  // labels, left side
  const lx = cx - 320
  lead(c, cx - 200, cy - 172, lx + 12, cy - 196); tag(c, lx, cy - 210, 'LT', ['スロットル下げ'], 'right')
  lead(c, cx - 215, cy - 130, lx + 12, cy - 106); tag(c, lx, cy - 120, 'LB', ['フラップ上げ'], 'right')
  lead(c, ls[0] - 30, ls[1] + 6, lx + 12, cy + 6); tag(c, lx, cy - 8, '左スティック', ['ピッチ / ロール', '押し込み： A/B'], 'right')
  lead(c, dp[0] - 30, dp[1] + 30, cx - 150, cy + 252); tag(c, cx - 140, cy + 240, '十字キー', ['上： フレア', '下： スモーク'], 'right')
  // labels, right side
  const rx = cx + 320
  lead(c, cx + 200, cy - 172, rx - 12, cy - 196); tag(c, rx, cy - 210, 'RT', ['スロットル上げ'])
  lead(c, cx + 215, cy - 130, rx - 12, cy - 106); tag(c, rx, cy - 120, 'RB', ['フラップ下げ'])
  const legend: Array<[string, string, string]> = [['Y', '#e8c85a', '脚'], ['X', '#5a9be8', 'ブレーキ'], ['B', '#e8615a', '武器切替'], ['A', '#5fc86a', '射撃']]
  legend.forEach(([n, col, does], i) => {
    const y = cy - 26 + i * 46
    disc(c, rx + 6, y, 18, col); text(c, n, rx + 6, y + 1, 20, '#101418', 'center', true)
    text(c, does, rx + 36, y, 30, SUB)
  })
  lead(c, rs[0] + 24, rs[1] + 34, cx + 150, cy + 252); tag(c, cx + 140, cy + 240, '右スティック', ['左右： ラダー', '押し込み： レーダー'])
}

// ---- VR controllers ---------------------------------------------------------
function controller(c: Ctx, cx: number, cy: number, right: boolean): { stick: number[]; trig: number[]; grip: number[]; a: number[]; b: number[] } {
  const s = right ? 1 : -1
  // tracking ring, trigger (front), handle with the grip button on its inner side
  disc(c, cx, cy - 20, 92, undefined, BODY_LINE, 14)
  rr(c, cx - 26, cy - 136, 52, 44, 14, KEY_ON, KEY_ON_LINE)
  rr(c, cx - 44, cy + 20, 88, 210, 40, BODY, BODY_LINE)
  rr(c, cx - s * 58, cy + 70, 26, 90, 12, KEY_ON, KEY_ON_LINE)
  disc(c, cx, cy - 20, 64, BODY, BODY_LINE)
  const stick = [cx - s * 20, cy - 34]
  disc(c, stick[0], stick[1], 24, KEY_ON, KEY_ON_LINE)
  const a = [cx + s * 28, cy + 4], b = [cx + s * 40, cy - 34]
  disc(c, a[0], a[1], 15, right ? KEY_ON : KEY_OFF, right ? KEY_ON_LINE : KEY_OFF_LINE)
  disc(c, b[0], b[1], 15, right ? KEY_ON : KEY_OFF, right ? KEY_ON_LINE : KEY_OFF_LINE)
  text(c, right ? 'A' : 'X', a[0], a[1] + 1, 18, right ? TEXT : DIM, 'center', true)
  text(c, right ? 'B' : 'Y', b[0], b[1] + 1, 18, right ? TEXT : DIM, 'center', true)
  return { stick, trig: [cx, cy - 114], grip: [cx - s * 45, cy + 115], a, b }
}

function drawVr(c: Ctx, x0: number, y0: number): void {
  panel(c, x0, y0, 1420, 530, 'VR')
  const cy = y0 + 250
  const L = controller(c, x0 + 580, cy, false)
  const R = controller(c, x0 + 900, cy, true)
  text(c, '左手', x0 + 580, y0 + 500, 28, DIM, 'center')
  text(c, '右手', x0 + 900, y0 + 500, 28, DIM, 'center')
  // left hand
  const lx = x0 + 430
  lead(c, L.trig[0] - 20, L.trig[1], lx + 12, cy - 116); lead(c, L.stick[0] - 10, L.stick[1], lx + 12, cy - 116)
  tag(c, lx, cy - 130, 'スティック ＋ トリガー', ['倒して機能を選び', 'トリガーで実行（左右とも）'], 'right')
  lead(c, L.grip[0] + 16, L.grip[1], lx + 12, cy + 80); tag(c, lx, cy + 66, '左グリップを握る', ['手を前後 ＝ スロットル', '奥へ押し込む ＝ A/B'], 'right')
  // right hand
  const rx = x0 + 1050
  lead(c, R.b[0] + 10, R.b[1] - 6, rx - 12, cy - 150); tag(c, rx, cy - 164, 'B', ['ブレーキ'])
  lead(c, R.a[0] + 12, R.a[1] + 4, rx - 12, cy - 46); tag(c, rx, cy - 60, 'A 長押し', ['降りる'])
  lead(c, R.grip[0] - 16, R.grip[1], rx - 12, cy + 80); tag(c, rx, cy + 66, '右グリップを握る', ['手首を傾ける ＝', 'ピッチ / ロール', 'ひねる ＝ ラダー'])
  text(c, 'グリップを素早く2度握ると、握ったまま固定', x0 + 740, y0 + 46, 28, DIM, 'center')
}

// ---- phone ------------------------------------------------------------------
function drawPhone(c: Ctx, x0: number, y0: number): void {
  panel(c, x0, y0, 1100, 530, 'スマホ')
  const px = x0 + 40, py = y0 + 110, pw = 560, ph = 300
  rr(c, px, py, pw, ph, 34, '#0b0e12', BODY_LINE, 5)
  // HUD glass and the switch panel under it
  rr(c, px + 150, py + 28, 260, 96, 8, undefined, '#4dd06a', 2)
  text(c, 'HUD', px + 280, py + 76, 26, '#4dd06a', 'center')
  const labels = ['THR-', 'THR+', 'A/B', 'GEAR', 'BRK', 'FLP', 'FLP', 'FIRE']
  labels.forEach((s, i) => {
    const bx = px + 150 + (i % 4) * 66, by = py + 140 + Math.floor(i / 4) * 44
    rr(c, bx, by, 60, 38, 6, KEY_ON, KEY_ON_LINE, 2)
    text(c, s, bx + 30, by + 20, 15, TEXT, 'center', true)
  })
  // crosshair in the middle of the screen
  c.strokeStyle = TEXT; c.lineWidth = 2
  c.beginPath(); c.moveTo(px + 268, py + 180); c.lineTo(px + 292, py + 180); c.moveTo(px + 280, py + 168); c.lineTo(px + 280, py + 192); c.stroke()
  // virtual stick, interact and jump buttons
  const st = [px + 76, py + 226]
  disc(c, st[0], st[1], 52, KEY_OFF, BODY_LINE); disc(c, st[0], st[1], 26, KEY_ON, KEY_ON_LINE)
  const it = [px + 500, py + 170], jp = [px + 500, py + 246]
  disc(c, it[0], it[1], 30, KEY_ON, KEY_ON_LINE); disc(c, jp[0], jp[1], 30, KEY_ON, KEY_ON_LINE)
  // labels
  const lx = px + pw + 60
  lead(c, px + 410, py + 160, lx - 12, py + 16); tag(c, lx, py + 2, 'HUD下のボタン', ['見て（画面中央に合わせて）', 'インタラクトで押す'])
  lead(c, it[0] + 30, it[1], lx - 12, py + 152); tag(c, lx, py + 138, 'インタラクト', ['ボタンを押す'])
  lead(c, jp[0] + 30, jp[1], lx - 12, py + 248); tag(c, lx, py + 234, 'ジャンプ長押し', ['降りる'])
  lead(c, st[0], st[1] + 52, px + 76, py + ph + 40); tag(c, px + 20, py + ph + 42, 'スティック： ピッチ / ロール', [])
}

export function drawControlsDiagram(c: Ctx): void {
  c.fillStyle = BG
  c.fillRect(0, 0, DIAGRAM_W, DIAGRAM_H)
  text(c, '操作方法', 40, 62, 72, TEXT, 'left', true)
  text(c, '右のキオスクで機体と開始位置を選んで「飛行開始」。降りた機体には、歩いて戻れば乗り直せます。', 380, 68, 34, SUB)
  drawPc(c, 30, 120)
  drawPad(c, 1470, 120)
  drawVr(c, 30, 850)
  drawPhone(c, 1470, 850)
}
