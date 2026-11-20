// 붓 터치 재생기: strokes.js에 담긴 계획을 한 획씩 캔버스에 칠한다.
// 사진은 캔버스에 직접 그리지 않는다 — 모든 픽셀은 붓 터치로만 만들어진다.
(() => {
  const STAGES = ["Blocking in", "Form and color", "Refinement", "Fine details"];
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const $count = document.getElementById("count");
  const $size = document.getElementById("size");
  const $opacity = document.getElementById("opacity");
  const $swatch = document.getElementById("swatch");
  const $stage = document.getElementById("stage");

  // 빈 흰 캔버스로 시작
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 결정적 난수 (매번 같은 그림)
  let seed = 12345;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 압축 배열 → 획 목록
  const strokes = [];
  const D = window.STROKES;
  for (let i = 0; i < D.length; ) {
    const s = { stage: D[i], r: D[i + 1] / 10, a: D[i + 2] / 100, c: [D[i + 3], D[i + 4], D[i + 5]] };
    const n = D[i + 6];
    i += 7;
    s.pts = [];
    for (let k = 0; k < n; k++, i += 2) s.pts.push([D[i], D[i + 1]]);
    if (s.pts.length === 1) s.pts.push([s.pts[0][0] + 0.5, s.pts[0][1] + 0.3]);
    strokes.push(s);
  }

  // 부드러운 곡선 경로
  function tracePath(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
  }

  // 각 점의 법선(붓 방향의 수직) 계산
  function normals(pts) {
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      return [-dy / len, dx / len];
    });
  }

  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));

  // 붓 한 획: 큰 붓은 여러 가닥의 '모(bristle)'로, 작은 붓은 둥근 붓 한 줄로
  function drawStroke(s) {
    const [r, g, b] = s.c;
    if (s.r < 3) {
      ctx.globalAlpha = s.a;
      ctx.strokeStyle = `rgb(${r},${g},${b})`;
      ctx.lineWidth = s.r * 2;
      tracePath(s.pts);
      ctx.stroke();
      return;
    }
    const k = Math.min(16, Math.max(3, Math.round(s.r / 2.5)));
    const nrm = normals(s.pts);
    const w = s.r * 2;
    for (let i = 0; i < k; i++) {
      const t = (i + 0.5) / k - 0.5;
      const off = t * w * 0.92 + (rand() - 0.5) * (w / k) * 0.5;
      const edge = Math.abs(t) * 2;
      const j = (rand() - 0.5) * 12;
      ctx.globalAlpha = s.a * 0.8 * (1 - 0.4 * edge * edge) * (0.8 + 0.2 * rand());
      ctx.strokeStyle = `rgb(${clamp(r + j)},${clamp(g + j)},${clamp(b + j)})`;
      ctx.lineWidth = (w / k) * 1.9;
      tracePath(s.pts.map((p, q) => [p[0] + nrm[q][0] * off, p[1] + nrm[q][1] * off]));
      ctx.stroke();
    }
  }

  // UI 갱신 (툴바: 크기, 불투명도, 현재 색)
  function updateUI(s, n) {
    $count.textContent = n.toLocaleString("en-US");
    $size.textContent = `${(s.r * 2).toFixed(s.r < 3 ? 1 : 0)} px`;
    $opacity.textContent = `${Math.round(s.a * 100)}%`;
    $swatch.style.background = `rgb(${s.c[0]},${s.c[1]},${s.c[2]})`;
    $stage.textContent = STAGES[s.stage];
  }

  // 단계별 프레임당 획 수: 큰 붓은 천천히, 세부 묘사는 빠르게 (전체 약 15초)
  const PER_FRAME = [6, 30, 150, 600];
  let idx = 0;
  function frame() {
    const t0 = performance.now();
    let n = 0;
    while (idx < strokes.length && n < PER_FRAME[strokes[idx].stage] && performance.now() - t0 < 14) {
      drawStroke(strokes[idx++]);
      n++;
    }
    if (idx > 0) updateUI(strokes[idx - 1], idx);
    if (idx < strokes.length) {
      requestAnimationFrame(frame);
    } else {
      ctx.globalAlpha = 1;
      $stage.textContent = "Fine details · done";
      window.PAINT_DONE = true;
    }
  }
  requestAnimationFrame(frame);
})();
