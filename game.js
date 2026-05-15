const paintCanvas = document.getElementById("paintCanvas");
const activeCanvas = document.getElementById("activePaintCanvas");
const paintCtx = paintCanvas.getContext("2d", { willReadFrequently: false });
const activeCtx = activeCanvas.getContext("2d", { willReadFrequently: false });
const snapshotCanvas = document.createElement("canvas");
const snapshotCtx = snapshotCanvas.getContext("2d", { willReadFrequently: false });
let canvas = activeCanvas;
let ctx = activeCtx;
const stage = document.getElementById("gameStage");
const cardSelectButton = document.getElementById("cardSelectButton");
const selectionBackButton = document.getElementById("selectionBackButton");
const selectedPageArt = document.getElementById("selectedPageArt");
const gameImages = [...document.querySelectorAll("img")];
const colorButtons = [...document.querySelectorAll(".color-button")];
const toolButtons = [...document.querySelectorAll(".tool-button")];
const drawingSelectButtons = [...document.querySelectorAll(".drawing-select-button")];

const STAGE_WIDTH = 5200;
const STAGE_HEIGHT = 2400;
const PAGE_COUNT = 10;
const PAGE_ASSETS = Array.from({ length: PAGE_COUNT }, (_, index) => {
  const page = String(index + 1);
  return [page, `assets/pages-fast/episode-1-${page}.png`];
});
const preloadedPages = new Map();

const state = {
  color: "#ea5d49",
  tool: "brush",
  strokes: [],
  activeStroke: null,
  pointerId: null,
  page: "10",
  needsRender: false,
  viewportResizeFrame: null,
};

const toolSettings = {
  marker: { size: 0.027 },
  pencil: { size: 0.014 },
  brush: { size: 0.043 },
  eraser: { size: 0.06 },
};

function decodeImage(image) {
  if (!image) {
    return Promise.resolve();
  }

  const ready = image.complete && image.naturalWidth > 0;
  const waitForLoad = ready
    ? Promise.resolve()
    : new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });

  return waitForLoad.then(() => {
    if (typeof image.decode === "function") {
      return image.decode().catch(() => {});
    }
    return undefined;
  });
}

function createPreloadedPage(page, src) {
  if (preloadedPages.has(page)) {
    return preloadedPages.get(page);
  }

  const img = new Image();
  img.decoding = "async";
  img.loading = "eager";
  img.src = src;
  preloadedPages.set(page, img);
  decodeImage(img);
  return img;
}

function scheduleIdleTask(callback) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(callback, { timeout: 1800 });
  } else {
    setTimeout(callback, 240);
  }
}

function preloadDrawingPages() {
  const currentPage = PAGE_ASSETS.find(([page]) => page === state.page);
  if (currentPage) {
    createPreloadedPage(currentPage[0], currentPage[1]);
  }

  const queue = PAGE_ASSETS.filter(([page]) => page !== state.page);
  let nextIndex = 0;

  function preloadNextPage() {
    const pageAsset = queue[nextIndex];
    nextIndex += 1;

    if (!pageAsset) {
      return;
    }

    createPreloadedPage(pageAsset[0], pageAsset[1]);
    scheduleIdleTask(preloadNextPage);
  }

  scheduleIdleTask(preloadNextPage);
}

function warmupGameImages() {
  return Promise.allSettled(gameImages.map(decodeImage));
}

function useDrawTarget(targetCanvas, targetCtx, callback) {
  const previousCanvas = canvas;
  const previousCtx = ctx;

  canvas = targetCanvas;
  ctx = targetCtx;

  try {
    return callback();
  } finally {
    canvas = previousCanvas;
    ctx = previousCtx;
  }
}

function clearActiveLayer() {
  activeCtx.clearRect(0, 0, activeCanvas.width, activeCanvas.height);
}

function capturePaintSnapshot() {
  snapshotCtx.clearRect(0, 0, snapshotCanvas.width, snapshotCanvas.height);
  snapshotCtx.drawImage(paintCanvas, 0, 0);
}

function restorePaintSnapshot() {
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  paintCtx.drawImage(snapshotCanvas, 0, 0);
}

function resizeCanvas() {
  const rect = activeCanvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  const nextWidth = Math.max(1, Math.round(rect.width * dpr));
  const nextHeight = Math.max(1, Math.round(rect.height * dpr));

  if (
    paintCanvas.width === nextWidth &&
    paintCanvas.height === nextHeight &&
    activeCanvas.width === nextWidth &&
    activeCanvas.height === nextHeight
  ) {
    return;
  }

  paintCanvas.width = nextWidth;
  paintCanvas.height = nextHeight;
  activeCanvas.width = nextWidth;
  activeCanvas.height = nextHeight;
  snapshotCanvas.width = nextWidth;
  snapshotCanvas.height = nextHeight;
  redrawCommittedStrokes();
}

function requestStageFit() {
  cancelAnimationFrame(state.viewportResizeFrame);
  state.viewportResizeFrame = requestAnimationFrame(fitStageToViewport);
}

function fitStageToViewport() {
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth || document.documentElement.clientWidth || STAGE_WIDTH;
  const height = viewport?.height || window.innerHeight || document.documentElement.clientHeight || STAGE_HEIGHT;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const scale = Math.min(width / STAGE_WIDTH, height / STAGE_HEIGHT, 1);

  document.documentElement.style.setProperty("--stage-scale", scale.toFixed(5));
  stage.style.left = `${left + width / 2}px`;
  stage.style.top = `${top + height / 2}px`;
  resizeCanvas();
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function colorWithAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function noise(seed, a, b) {
  const x = Math.sin(seed * 12.9898 + a * 78.233 + b * 37.719) * 43758.5453;
  return x - Math.floor(x);
}

function pointToCanvas(point) {
  return {
    x: point.x * canvas.width,
    y: point.y * canvas.height,
  };
}

function drawPath(points, lineWidth, strokeStyle, options = {}) {
  if (points.length === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = options.composite || "source-over";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = strokeStyle;
  ctx.beginPath();

  const start = pointToCanvas(points[0]);
  ctx.moveTo(start.x, start.y);

  if (points.length === 1) {
    ctx.lineTo(start.x + 0.01, start.y + 0.01);
  } else {
    for (let i = 1; i < points.length; i += 1) {
      const current = pointToCanvas(points[i]);
      const previous = pointToCanvas(points[i - 1]);
      const midX = (previous.x + current.x) / 2;
      const midY = (previous.y + current.y) / 2;
      ctx.quadraticCurveTo(previous.x, previous.y, midX, midY);
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawMarker(stroke, scale) {
  const size = toolSettings.marker.size * scale;
  drawPath(stroke.points, size, colorWithAlpha(stroke.color, 0.62));
  drawPath(stroke.points, size * 0.55, colorWithAlpha(stroke.color, 0.28));
}

function drawEraser(stroke, scale) {
  const size = toolSettings.eraser.size * scale;
  drawPath(stroke.points, size, "rgba(0, 0, 0, 1)", { composite: "destination-out" });
}

function drawPencil(stroke, scale) {
  const baseSize = toolSettings.pencil.size * scale;

  for (let pass = 0; pass < 7; pass += 1) {
    const jitter = baseSize * (0.55 + pass * 0.08);
    const roughPoints = stroke.points.map((point, index) => ({
      x: point.x + ((noise(stroke.seed, pass, index) - 0.5) * jitter) / canvas.width,
      y: point.y + ((noise(stroke.seed + 17, pass, index) - 0.5) * jitter) / canvas.height,
    }));
    drawPath(roughPoints, baseSize * (0.26 + noise(stroke.seed, pass, 99) * 0.18), colorWithAlpha(stroke.color, 0.2));
  }

  ctx.save();
  ctx.fillStyle = colorWithAlpha(stroke.color, 0.15);
  for (let i = 0; i < stroke.points.length; i += 2) {
    const point = pointToCanvas(stroke.points[i]);
    const radius = baseSize * (0.14 + noise(stroke.seed, i, 8) * 0.2);
    const x = point.x + (noise(stroke.seed, i, 2) - 0.5) * baseSize * 1.3;
    const y = point.y + (noise(stroke.seed, i, 3) - 0.5) * baseSize * 1.3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBrush(stroke, scale) {
  const baseSize = toolSettings.brush.size * scale;

  for (let pass = 0; pass < 9; pass += 1) {
    const offset = baseSize * (noise(stroke.seed, pass, 1) - 0.5) * 0.95;
    const bristlePoints = stroke.points.map((point, index) => ({
      x: point.x + ((noise(stroke.seed, pass, index) - 0.5) * baseSize * 0.38 + offset) / canvas.width,
      y: point.y + ((noise(stroke.seed + 31, pass, index) - 0.5) * baseSize * 0.38 - offset * 0.25) / canvas.height,
    }));
    const width = baseSize * (0.17 + noise(stroke.seed, pass, 12) * 0.2);
    drawPath(bristlePoints, width, colorWithAlpha(stroke.color, 0.21));
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const softPoints = stroke.points.map((point, index) => ({
      x: point.x + ((noise(stroke.seed + 71, pass, index) - 0.5) * baseSize * 0.18) / canvas.width,
      y: point.y + ((noise(stroke.seed + 91, pass, index) - 0.5) * baseSize * 0.18) / canvas.height,
    }));
    drawPath(softPoints, baseSize * (0.56 - pass * 0.11), colorWithAlpha(stroke.color, 0.1));
  }
}

function renderStroke(stroke) {
  const scale = Math.min(canvas.width, canvas.height);

  if (stroke.tool === "marker") {
    drawMarker(stroke, scale);
  } else if (stroke.tool === "pencil") {
    drawPencil(stroke, scale);
  } else if (stroke.tool === "eraser") {
    drawEraser(stroke, scale);
  } else {
    drawBrush(stroke, scale);
  }
}

function renderActiveStroke() {
  clearActiveLayer();

  if (state.activeStroke) {
    restorePaintSnapshot();
    useDrawTarget(paintCanvas, paintCtx, () => renderStroke(state.activeStroke));
  }

  state.needsRender = false;
}

function redrawCommittedStrokes() {
  paintCtx.clearRect(0, 0, paintCanvas.width, paintCanvas.height);
  useDrawTarget(paintCanvas, paintCtx, () => {
    state.strokes.forEach(renderStroke);
  });

  if (state.activeStroke) {
    capturePaintSnapshot();
    renderActiveStroke();
  } else {
    clearActiveLayer();
    state.needsRender = false;
  }
}

function render() {
  redrawCommittedStrokes();
}

function scheduleRender() {
  if (state.needsRender) return;
  state.needsRender = true;
  requestAnimationFrame(renderActiveStroke);
}

function getCanvasPoint(event) {
  const rect = activeCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function addPoint(event) {
  if (!state.activeStroke) return;

  const nextPoint = getCanvasPoint(event);
  const points = state.activeStroke.points;
  const previous = points[points.length - 1];
  const dx = nextPoint.x - previous.x;
  const dy = nextPoint.y - previous.y;

  if (Math.hypot(dx, dy) > 0.0025) {
    points.push(nextPoint);
    scheduleRender();
  }
}

function startStroke(event) {
  event.preventDefault();
  resizeCanvas();
  state.pointerId = event.pointerId;
  activeCanvas.setPointerCapture(event.pointerId);
  state.activeStroke = {
    tool: state.tool,
    color: state.color,
    seed: Date.now() + Math.random() * 1000,
    points: [getCanvasPoint(event)],
  };
  capturePaintSnapshot();
  scheduleRender();
}

function moveStroke(event) {
  if (event.pointerId !== state.pointerId) return;
  event.preventDefault();
  addPoint(event);
}

function finishStroke(event) {
  if (event.pointerId !== state.pointerId || !state.activeStroke) return;
  event.preventDefault();
  addPoint(event);

  const finishedStroke = state.activeStroke;
  renderActiveStroke();
  state.strokes.push(finishedStroke);
  state.activeStroke = null;
  state.pointerId = null;
  clearActiveLayer();
  state.needsRender = false;
}

function cancelStroke() {
  if (!state.activeStroke && state.pointerId === null) {
    return;
  }

  state.activeStroke = null;
  state.pointerId = null;
  restorePaintSnapshot();
  clearActiveLayer();
  state.needsRender = false;
}

function selectColor(button) {
  state.color = button.dataset.color;
  colorButtons.forEach((item) => item.classList.toggle("is-active", item === button));
}

function selectTool(button) {
  state.tool = button.dataset.tool;
  toolButtons.forEach((item) => item.classList.toggle("is-active", item === button));
  activeCanvas.style.cursor = state.tool === "eraser" ? "grab" : "crosshair";
}

function openDrawingSelection() {
  cancelStroke();
  stage.classList.add("is-selecting");
}

function closeDrawingSelection() {
  stage.classList.remove("is-selecting");
}

function clearDrawing() {
  state.strokes = [];
  state.activeStroke = null;
  state.pointerId = null;
  render();
}

function selectDrawingPage(button) {
  const page = button.dataset.page;
  if (!page) return;

  state.page = page;
  const pageAsset = PAGE_ASSETS.find(([assetPage]) => assetPage === page);
  const pageImage = pageAsset ? createPreloadedPage(pageAsset[0], pageAsset[1]) : null;
  selectedPageArt.src = pageImage?.src || `assets/pages-fast/episode-1-${page}.png`;
  drawingSelectButtons.forEach((item) => item.classList.toggle("is-active", item === button));
  clearDrawing();
  closeDrawingSelection();
}

colorButtons.forEach((button) => {
  button.addEventListener("click", () => selectColor(button));
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => selectTool(button));
});

cardSelectButton.addEventListener("click", openDrawingSelection);
selectionBackButton.addEventListener("click", closeDrawingSelection);

drawingSelectButtons.forEach((button) => {
  button.addEventListener("click", () => selectDrawingPage(button));
});

activeCanvas.addEventListener("pointerdown", startStroke);
activeCanvas.addEventListener("pointermove", moveStroke);
activeCanvas.addEventListener("pointerup", finishStroke);
activeCanvas.addEventListener("pointercancel", cancelStroke);
activeCanvas.addEventListener("lostpointercapture", cancelStroke);

window.addEventListener("resize", resizeCanvas);
window.addEventListener("resize", requestStageFit);
window.addEventListener("load", requestStageFit);
window.addEventListener("pageshow", requestStageFit);
window.addEventListener("orientationchange", () => {
  requestStageFit();
  setTimeout(requestStageFit, 250);
  setTimeout(requestStageFit, 650);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", requestStageFit);
  window.visualViewport.addEventListener("scroll", requestStageFit);
}

document.addEventListener("keydown", (event) => {
  const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z";
  if (isUndo && state.strokes.length > 0) {
    state.strokes.pop();
    redrawCommittedStrokes();
  }
});

fitStageToViewport();
warmupGameImages();
preloadDrawingPages();
