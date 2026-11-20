// 붓 터치 재생기: strokes.js에 담긴 계획을 붓이 움직이듯 조금씩 캔버스에 칠한다.
// 사진은 캔버스에 직접 그리지 않는다 — 모든 픽셀은 붓 터치로만 만들어진다.
// 붓 커서·통계·팔레트는 그림과 분리된 화면 요소(DOM)로만 표시한다.
(() => {
  const STAGES = ["Blocking in", "Form and color", "Refinement", "Fine details"];
  const SECONDS = [10, 10, 10, 15]; // 단계별 재생 시간 (전체 약 45초, 화면 주사율과 무관)
  const Q = 32; // 팔레트에서 비슷한 색을 하나로 묶는 간격

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const $ = (id) => document.getElementById(id);
  const ui = {
    count: $("count"), brushName: $("brushName"), brushPreview: $("brushPreview"),
    sizeRange: $("sizeRange"), sizeVal: $("sizeVal"), opRange: $("opRange"), opVal: $("opVal"),
    colorSwatch: $("colorSwatch"), hex: $("hex"), rgb: $("rgb"),
    stageOf: $("stageOf"), stageName: $("stageName"),
    statStrokes: $("statStrokes"), statColors: $("statColors"),
    stageList: $("stageList"), palette: $("palette"), paletteInfo: $("paletteInfo"),
    canvasBox: $("canvasBox"), brushCursor: $("brushCursor"), refCursor: $("refCursor"),
  };

  // 빈 흰 캔버스로 시작
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, W, H);
  ctx.lineJoin = "round";

  // 결정적 난수 (매번 같은 그림)
  let seed = 12345;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 압축 배열 → 획 목록, 단계별 통계
  const strokes = [];
  const pieces = [0, 0, 0, 0];
  const sizeMin = [Infinity, Infinity, Infinity, Infinity];
  const sizeMax = [0, 0, 0, 0];
  const D = window.STROKES;
  for (let i = 0; i < D.length; ) {
    const s = { stage: D[i], r: D[i + 1] / 10, a: D[i + 2] / 100, c: [D[i + 3], D[i + 4], D[i + 5]] };
    const n = D[i + 6];
    i += 7;
    s.pts = [];
    for (let k = 0; k < n; k++, i += 2) s.pts.push([D[i], D[i + 1]]);
    if (s.pts.length === 1) s.pts.push([s.pts[0][0] + 0.5, s.pts[0][1] + 0.3]);
    pieces[s.stage] += s.pts.length - 1;
    sizeMin[s.stage] = Math.min(sizeMin[s.stage], s.r * 2);
    sizeMax[s.stage] = Math.max(sizeMax[s.stage], s.r * 2);
    strokes.push(s);
  }
  // 단계별로 1밀리초에 그릴 조각 수
  const perMs = pieces.map((p, i) => p / (SECONDS[i] * 1000));

  // 단계 목록 만들기
  const fmt = (v) => (v < 10 ? v.toFixed(1) : Math.round(v));
  const stageRows = STAGES.map((name, i) => {
    const li = document.createElement("li");
    const range = sizeMin[i] === sizeMax[i] ? `${fmt(sizeMax[i])} px` : `${fmt(sizeMin[i])}–${fmt(sizeMax[i])} px`;
    li.innerHTML = `<span class="ico"></span><span>${name}</span><span class="size">${range}</span>`;
    ui.stageList.appendChild(li);
    return li;
  });

  // 붓 경로를 '조각' 단위로 나눠 그린다 (조각끼리 겹치지 않아 이음매에 얼룩이 생기지 않음)
  const mid = (p, i) => [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
  function tracePiece(p, k) {
    const L = p.length;
    ctx.beginPath();
    if (L === 2) {
      ctx.moveTo(p[0][0], p[0][1]);
      ctx.lineTo(p[1][0], p[1][1]);
    } else if (k === 0) {
      const m = mid(p, 1);
      ctx.moveTo(p[0][0], p[0][1]);
      ctx.quadraticCurveTo(p[1][0], p[1][1], m[0], m[1]);
    } else if (k === L - 2) {
      const m = mid(p, L - 2);
      ctx.moveTo(m[0], m[1]);
      ctx.lineTo(p[L - 1][0], p[L - 1][1]);
    } else {
      const a = mid(p, k), b = mid(p, k + 1);
      ctx.moveTo(a[0], a[1]);
      ctx.quadraticCurveTo(p[k + 1][0], p[k + 1][1], b[0], b[1]);
    }
  }
  // 조각 k를 그린 뒤 붓이 있는 위치
  function pieceEnd(p, k) {
    const L = p.length;
    if (k >= L - 2) return p[L - 1];
    return mid(p, k + 1);
  }

  // 각 점의 법선(붓 방향의 수직)
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

  // 조각은 끝이 평평(butt)하므로, 양 끝을 붓 반지름만큼 늘려 둥근 끝이 덮던 자리를 채운다
  function extendEnds(pts, ext) {
    if (pts.length < 3) return pts;
    const out = pts.map((p) => [p[0], p[1]]);
    const L = out.length;
    const grow = (i, j) => {
      const dx = out[i][0] - out[j][0], dy = out[i][1] - out[j][1];
      const len = Math.hypot(dx, dy) || 1;
      out[i][0] += (dx / len) * ext;
      out[i][1] += (dy / len) * ext;
    };
    grow(0, 1);
    grow(L - 1, L - 2);
    return out;
  }

  // 획을 시작할 때 붓털(가닥)을 준비: 큰 붓은 여러 가닥, 작은 붓은 둥근 붓 한 줄
  function prepare(s) {
    const [r, g, b] = s.c;
    if (s.r < 3) {
      return [{ pts: extendEnds(s.pts, s.r), alpha: s.a, color: `rgb(${r},${g},${b})`, width: s.r * 2 }];
    }
    const k = Math.min(16, Math.max(3, Math.round(s.r / 2.5)));
    const nrm = normals(s.pts);
    const w = s.r * 2;
    const out = [];
    for (let i = 0; i < k; i++) {
      const t = (i + 0.5) / k - 0.5;
      const off = t * w * 0.92 + (rand() - 0.5) * (w / k) * 0.5;
      const edge = Math.abs(t) * 2;
      const j = (rand() - 0.5) * 12;
      out.push({
        pts: extendEnds(s.pts.map((p, q) => [p[0] + nrm[q][0] * off, p[1] + nrm[q][1] * off]), s.r * 0.9),
        alpha: s.a * 0.8 * (1 - 0.4 * edge * edge) * (0.8 + 0.2 * rand()),
        color: `rgb(${clamp(r + j)},${clamp(g + j)},${clamp(b + j)})`,
        width: (w / k) * 1.9,
      });
    }
    return out;
  }

  // 누적 팔레트: 비슷한 색은 하나의 칸으로
  const paletteMap = new Map();
  let currentSwatch = null;
  function paletteSwatch(c) {
    const key = c.map((v) => Math.floor(v / Q)).join(",");
    let el = paletteMap.get(key);
    if (!el) {
      el = document.createElement("div");
      el.className = "sw";
      el.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
      el.title = toHex(c);
      ui.palette.appendChild(el);
      paletteMap.set(key, el);
    }
    return el;
  }
  const toHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

  // 단계 표시 갱신
  let shownStage = -1;
  function setStage(st, finished) {
    stageRows.forEach((li, i) => {
      li.className = finished || i < st ? "done" : i === st ? "active" : "";
    });
    ui.stageOf.textContent = `Stage ${st + 1} of ${STAGES.length}`;
    ui.stageName.textContent = finished ? "Done" : STAGES[st];
    shownStage = st;
  }

  // 상단 바·통계·팔레트 갱신
  function updateUI(s, started) {
    const n = started.toLocaleString("en-US");
    ui.count.textContent = n;
    ui.statStrokes.textContent = n;
    ui.statColors.textContent = paletteMap.size;
    ui.paletteInfo.textContent = `${paletteMap.size} colors · ${STAGES[s.stage]}`;
    const bristle = s.r >= 3;
    ui.brushName.textContent = bristle ? "Bristle" : "Soft round";
    ui.brushPreview.className = "brush-preview " + (bristle ? "bristle" : "soft");
    ui.sizeRange.value = s.r * 2;
    ui.sizeVal.textContent = fmt(s.r * 2);
    ui.opRange.value = Math.round(s.a * 100);
    ui.opVal.textContent = Math.round(s.a * 100);
    ui.colorSwatch.style.background = `rgb(${s.c[0]},${s.c[1]},${s.c[2]})`;
    ui.hex.textContent = toHex(s.c);
    ui.rgb.textContent = `R ${s.c[0]} G ${s.c[1]} B ${s.c[2]}`;
    if (s.stage !== shownStage) setStage(s.stage, false);
  }

  // 붓 커서: 캔버스와 참고 이미지에 같은 상대 위치로 표시
  const refImg = document.querySelector(".ref-box img");
  function moveCursors(x, y, r) {
    const scale = ui.canvasBox.clientWidth / W;
    const d = Math.max(6, r * 2 * scale);
    const bc = ui.brushCursor.style;
    bc.left = `${(x / W) * 100}%`;
    bc.top = `${(y / H) * 100}%`;
    bc.width = bc.height = `${d}px`;
    // 참고 이미지는 상자 가운데 정렬되어 있으므로 이미지 자체 위치 기준으로 계산
    const rc = ui.refCursor.style;
    rc.left = `${refImg.offsetLeft - refImg.offsetWidth / 2 + (x / W) * refImg.offsetWidth}px`;
    rc.top = `${(y / H) * refImg.offsetHeight}px`;
  }

  // 메인 루프: 프레임마다 정해진 수의 조각만큼 붓을 움직인다
  let si = 0;        // 다음에 시작할 획 번호
  let cur = null;    // 지금 그리는 획
  let k = 0;         // 지금 획에서 다음 조각 번호
  let last = null;   // 방금 끝난 획 (커서 위치용)
  ui.brushCursor.hidden = false;
  ui.refCursor.hidden = false;

  let prevTime = null;
  let carry = 0; // 소수점 이하로 남은 조각 수를 다음 프레임으로 넘김
  function frame(now) {
    const dt = prevTime === null ? 16 : Math.min(100, now - prevTime);
    prevTime = now;
    const stage = cur ? cur.s.stage : strokes[Math.min(si, strokes.length - 1)].stage;
    carry += perMs[stage] * dt;
    let budget = Math.floor(carry);
    carry -= budget;
    while (budget-- > 0) {
      if (!cur) {
        if (si >= strokes.length) break;
        const s = strokes[si++];
        cur = { s, brs: prepare(s), n: s.pts.length - 1 };
        k = 0;
        // 팔레트에 색 추가하고 현재 색 강조
        const sw = paletteSwatch(s.c);
        if (currentSwatch !== sw) {
          if (currentSwatch) currentSwatch.classList.remove("current");
          sw.classList.add("current");
          currentSwatch = sw;
        }
      }
      ctx.lineCap = cur.n === 1 ? "round" : "butt";
      for (const b of cur.brs) {
        ctx.globalAlpha = b.alpha;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.width;
        tracePiece(b.pts, k);
        ctx.stroke();
      }
      k++;
      if (k >= cur.n) {
        last = cur;
        cur = null;
      }
    }

    // 현재 붓 위치와 화면 갱신
    const show = cur || last;
    if (show) {
      const p = pieceEnd(show.s.pts, cur ? k - 1 : show.n - 1);
      moveCursors(p[0], p[1], show.s.r);
      updateUI(show.s, si);
    }

    if (cur || si < strokes.length) {
      requestAnimationFrame(frame);
    } else {
      // 완성: 커서를 숨기고 모든 단계를 완료로 표시
      ctx.globalAlpha = 1;
      ui.brushCursor.hidden = true;
      ui.refCursor.hidden = true;
      if (currentSwatch) currentSwatch.classList.remove("current");
      setStage(STAGES.length - 1, true);
      window.PAINT_DONE = true;
    }
  }
  setStage(0, false);
  requestAnimationFrame(frame);
})();
