# -*- coding: utf-8 -*-
"""
reference.png를 분석해 붓 터치 계획(strokes.js)을 만드는 스크립트.

비유: 화가가 사진을 옆에 두고 "어디가 아직 사진과 다른가?"를 계속 살피며
큰 붓 → 작은 붓 순서로 덧칠하는 과정을 코드로 흉내 낸다.
(Hertzmann의 '곡선 붓 터치 페인터리 렌더링' 방식을 단순화)

- 사진 자체는 캔버스에 그리지 않는다. 사진은 '어떤 색, 어느 방향으로 칠할지' 판단에만 쓴다.
- 파이썬 안에서 가상 캔버스에 같은 붓 터치를 칠해 보면서 오차가 큰 곳에만 다음 터치를 놓는다.
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# 캔버스 크기: 원본(1280x1932)의 정확히 0.75배 → 비율 동일
W, H = 960, 1449
SRC_W, SRC_H = 1280, 1932
SCALE = W / SRC_W

rng = np.random.default_rng(7)

# ---------------------------------------------------------------
# 1) 참고 이미지 불러오기 (분석 전용)
# ---------------------------------------------------------------
ref = Image.open("reference.png").convert("RGB").resize((W, H), Image.LANCZOS)
ref = np.asarray(ref).astype(np.float32)

# 가상 캔버스: 처음엔 완전히 흰 종이
canvas = np.full((H, W, 3), 255.0, dtype=np.float32)


def box(x0, y0, x1, y1):
    """원본 좌표계의 사각형을 캔버스 좌표로 변환"""
    return (int(x0 * SCALE), int(y0 * SCALE), int(x1 * SCALE), int(y1 * SCALE))


# 얼굴·눈·수염·흉배·각대·사모 등 '알아보게 만드는' 세부 영역 (원본 좌표 기준)
DETAIL_BOXES = {
    "hat": box(330, 55, 945, 430),
    "face": box(470, 370, 810, 700),
    "eyes": box(520, 420, 760, 480),
    "mouth": box(550, 540, 720, 650),
    "beard": box(470, 520, 800, 870),
    "beard_core": box(530, 660, 760, 860),
    "badge": box(430, 930, 875, 1300),
    "belt": box(390, 1280, 905, 1395),
    "fur_left": box(0, 820, 240, 1520),
    "fur_right": box(1040, 820, 1280, 1520),
}


def region_mask(names):
    """지정한 세부 영역들의 합집합 마스크"""
    m = np.zeros((H, W), dtype=bool)
    for n in names:
        x0, y0, x1, y1 = DETAIL_BOXES[n]
        m[y0:y1, x0:x1] = True
    return m


# 옷 주름선처럼 가늘고 어두운 선(윤곽선)을 찾는 마스크
lum_ref = ref @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
local_mean = ndimage.uniform_filter(lum_ref, 9)
line_mask = (local_mean - lum_ref) > 18
line_mask = ndimage.binary_dilation(line_mask, iterations=2)

# 인물(옷·모자·털) 영역: 배경 종이 결이 '선'으로 오인되어 낙서처럼 칠해지는 것을 막는다
figure_mask = ndimage.gaussian_filter(lum_ref, 6) < 175
figure_mask = ndimage.binary_dilation(figure_mask, iterations=6)
line_mask &= figure_mask


# ---------------------------------------------------------------
# 2) 가상 캔버스에 붓 터치 하나를 칠하는 함수
# ---------------------------------------------------------------
def render_stroke(pts, radius, color, alpha):
    """폴리라인 주변 거리로 부드러운 둥근 붓 자국을 만들어 알파 합성"""
    p = np.array(pts, dtype=np.float32)
    pad = radius + 2
    x0 = max(int(p[:, 0].min() - pad), 0)
    y0 = max(int(p[:, 1].min() - pad), 0)
    x1 = min(int(p[:, 0].max() + pad) + 1, W)
    y1 = min(int(p[:, 1].max() + pad) + 1, H)
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1].astype(np.float32)

    # 각 선분까지의 최소 거리
    dist = np.full(xs.shape, 1e9, dtype=np.float32)
    if len(p) == 1:
        dist = np.hypot(xs - p[0, 0], ys - p[0, 1])
    for a, b in zip(p[:-1], p[1:]):
        d = b - a
        L2 = float(d @ d) + 1e-6
        t = ((xs - a[0]) * d[0] + (ys - a[1]) * d[1]) / L2
        t = np.clip(t, 0.0, 1.0)
        dx = xs - (a[0] + t * d[0])
        dy = ys - (a[1] + t * d[1])
        dist = np.minimum(dist, np.hypot(dx, dy))

    # 가장자리는 부드럽게 (소프트 브러시)
    soft = max(1.0, radius * 0.35)
    m = np.clip((radius - dist) / soft + 0.5, 0.0, 1.0) * alpha
    m = m[..., None]
    region = canvas[y0:y1, x0:x1]
    region[:] = region * (1.0 - m) + np.array(color, dtype=np.float32) * m


# ---------------------------------------------------------------
# 3) 한 레이어(같은 크기 붓)를 칠하는 함수
# ---------------------------------------------------------------
def orientation_field(img, sigma):
    """구조 텐서로 '형태의 결' 방향을 구한다 (터치가 형태를 따라가도록)"""
    lum = img @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    gx = ndimage.sobel(lum, axis=1)
    gy = ndimage.sobel(lum, axis=0)
    jxx = ndimage.gaussian_filter(gx * gx, sigma)
    jyy = ndimage.gaussian_filter(gy * gy, sigma)
    jxy = ndimage.gaussian_filter(gx * gy, sigma)
    # 기울기 방향의 수직 = 등고선(결) 방향
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy) + np.pi / 2
    coherence = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2)
    return np.cos(theta), np.sin(theta), coherence


def paint_layer(stage, radius, threshold, max_len, alpha, mask=None, blur_k=0.5, grid_k=1.0):
    """오차가 큰 칸마다 곡선 붓 터치를 하나씩 놓는다"""
    blurred = ndimage.gaussian_filter(ref, sigma=(blur_k * radius, blur_k * radius, 0))
    cx, cy, coh = orientation_field(blurred, max(2.0, radius * 0.8))
    # 결이 약한(평평한) 곳은 살짝 사선으로 기본 방향을 준다
    weak = coh < np.percentile(coh, 25)
    cx = np.where(weak, 0.8, cx)
    cy = np.where(weak, 0.6, cy)

    diff = np.linalg.norm(canvas - blurred, axis=2)
    if mask is not None:
        diff = np.where(mask, diff, 0.0)

    grid = max(2, int(radius * grid_k))
    starts = []
    for gy in range(0, H, grid):
        for gx in range(0, W, grid):
            cell = diff[gy:gy + grid, gx:gx + grid]
            if cell.mean() > threshold:
                iy, ix = np.unravel_index(np.argmax(cell), cell.shape)
                # 격자 느낌을 없애기 위한 약간의 흔들림
                jx = gx + ix + rng.uniform(-grid * 0.3, grid * 0.3)
                jy = gy + iy + rng.uniform(-grid * 0.3, grid * 0.3)
                starts.append((float(np.clip(jx, 0, W - 1)), float(np.clip(jy, 0, H - 1))))
    rng.shuffle(starts)

    strokes = []
    for (x, y) in starts:
        color = blurred[int(y), int(x)].copy()
        pts = [(x, y)]
        px, py = 0.0, 0.0
        step = max(1.5, radius * 0.9)
        # 곡선 터치: 결 방향을 따라 조금씩 이동
        for _ in range(max_len):
            ix, iy = int(x), int(y)
            if len(pts) > 2:
                here_ref = np.linalg.norm(blurred[iy, ix] - color)
                here_can = np.linalg.norm(canvas[iy, ix] - color)
                if here_ref > here_can:
                    break
            dx, dy = cx[iy, ix], cy[iy, ix]
            # 앞 방향과 반대면 뒤집어서 매끄럽게 이어지도록
            if dx * px + dy * py < 0:
                dx, dy = -dx, -dy
            if px or py:
                dx, dy = 0.6 * dx + 0.4 * px, 0.6 * dy + 0.4 * py
                n = np.hypot(dx, dy) + 1e-6
                dx, dy = dx / n, dy / n
            x = x + dx * step
            y = y + dy * step
            if x < 0 or y < 0 or x >= W - 1 or y >= H - 1:
                break
            pts.append((x, y))
            px, py = dx, dy
        a = float(np.clip(alpha + rng.uniform(-0.08, 0.05), 0.05, 1.0))
        render_stroke(pts, radius, color, a)
        strokes.append((stage, radius, a, color, pts))
    print(f"stage {stage} r={radius}: {len(strokes)} strokes, err={err():.2f}", file=sys.stderr)
    return strokes


def hair_strands(stage, names, count, radius=0.8, max_steps=26):
    """수염 한 올 한 올: 어두운 털 픽셀에서 시작해 털 방향을 따라 길고 가는 획을 긋는다"""
    cx, cy, _ = orientation_field(ref, 2.0)
    m = region_mask(names)
    dark = (ndimage.uniform_filter(lum_ref, 7) - lum_ref) > 6
    ys, xs = np.nonzero(m & dark)
    pick = rng.choice(len(xs), size=min(count, len(xs)), replace=False)
    strokes = []
    for i in pick:
        x, y = float(xs[i]), float(ys[i])
        color = ref[int(y), int(x)].copy()
        pts = [(x, y)]
        px, py = 0.0, 1.0
        for _ in range(max_steps):
            dx, dy = cx[int(y), int(x)], cy[int(y), int(x)]
            if dx * px + dy * py < 0:
                dx, dy = -dx, -dy
            dx, dy = 0.5 * dx + 0.5 * px, 0.5 * dy + 0.5 * py
            n = np.hypot(dx, dy) + 1e-6
            dx, dy = dx / n, dy / n
            x, y = x + dx * 2.0, y + dy * 2.0
            if x < 0 or y < 0 or x >= W - 1 or y >= H - 1:
                break
            # 털 색에서 많이 벗어나면(피부·옷) 멈춘다
            if np.linalg.norm(ref[int(y), int(x)] - color) > 70:
                break
            pts.append((x, y))
            px, py = dx, dy
        if len(pts) < 3:
            continue
        a = float(rng.uniform(0.55, 0.8))
        render_stroke(pts, radius, color, a)
        strokes.append((stage, radius, a, color, pts))
    print(f"stage {stage} hair: {len(strokes)} strokes, err={err():.2f}", file=sys.stderr)
    return strokes


def err():
    """현재 가상 캔버스와 참고 이미지의 평균 색 차이"""
    return float(np.abs(canvas - ref).mean())


# ---------------------------------------------------------------
# 4) 단계별로 칠하기: 큰 덩어리 → 형태와 색 → 다듬기 → 세부
# ---------------------------------------------------------------
detail = region_mask(["hat", "face", "beard", "badge", "belt", "fur_left", "fur_right"])
face_fine = region_mask(["eyes", "mouth", "face", "beard"])

all_strokes = []
# 0: Blocking in
all_strokes += paint_layer(0, 56, 0, 6, 0.9, blur_k=0.9, grid_k=0.6)
all_strokes += paint_layer(0, 34, 14, 7, 0.85, blur_k=0.8)
# 1: Form and color
all_strokes += paint_layer(1, 20, 12, 8, 0.85)
all_strokes += paint_layer(1, 12, 12, 10, 0.85)
# 2: Refinement
all_strokes += paint_layer(2, 7, 12, 12, 0.85, mask=figure_mask | detail)
all_strokes += paint_layer(2, 4, 14, 14, 0.85, mask=(detail & figure_mask) | line_mask)
# 3: Fine details (얼굴·수염·흉배·주름선)
# 수염 몸통은 뭉개진 붓 대신 아래의 '털 한 올' 획으로 표현한다
beard_core = region_mask(["beard_core"])
all_strokes += paint_layer(3, 2.5, 14, 16, 0.85, mask=((detail & figure_mask) | line_mask) & ~beard_core, blur_k=0.3)
all_strokes += paint_layer(3, 1.5, 12, 18, 0.85, mask=(face_fine | region_mask(["badge", "belt"])) & ~beard_core, blur_k=0.25)
all_strokes += paint_layer(3, 1.0, 14, 18, 0.9, mask=face_fine | region_mask(["badge"]), blur_k=0.2)
all_strokes += hair_strands(3, ["beard", "mouth"], 12000)

# 마무리 손질: 브라우저에서 실제로 칠해진 결과(canvas.png)를 보고 어긋난 곳만 고친다.
# 위 계획은 난수 시드가 고정이라 매번 같으므로, 실제 캔버스 위에 덧칠 획만 추가하면 된다.
if len(sys.argv) > 2:
    canvas[:] = np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(np.float32)
    print(f"touch-up from real canvas, err={err():.2f}", file=sys.stderr)
    all_strokes += paint_layer(3, 2, 30, 12, 0.85, mask=~region_mask(["beard"]), blur_k=0.3)

# ---------------------------------------------------------------
# 5) strokes.js로 저장 (정수 배열로 압축)
# 형식: [단계, 반지름*10, 불투명도*100, R, G, B, 점개수, x1, y1, x2, y2, ...]
# ---------------------------------------------------------------
flat = []
for stage, radius, a, color, pts in all_strokes:
    flat += [stage, int(round(radius * 10)), int(round(a * 100))]
    flat += [int(round(c)) for c in color]
    flat.append(len(pts))
    for (x, y) in pts:
        flat += [int(round(x)), int(round(y))]

with open("strokes.js", "w", encoding="utf-8") as f:
    f.write("// 자동 생성: plan_strokes.py\n")
    f.write(f"window.CANVAS_W={W};window.CANVAS_H={H};window.STROKE_COUNT={len(all_strokes)};\n")
    f.write("window.STROKES=" + json.dumps(flat, separators=(",", ":")) + ";\n")

# 비교용 시뮬레이션 결과 저장 (앱에는 쓰지 않음)
Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8)).save(sys.argv[1] if len(sys.argv) > 1 else "sim.png")
print(f"total {len(all_strokes)} strokes, final err={err():.2f}", file=sys.stderr)
