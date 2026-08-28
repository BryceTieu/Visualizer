<script lang="ts">
  import type {
    Line,
    BasePoint,
    Settings,
    Point,
    SequenceItem,
    Shape,
  } from "./types";
  import * as d3 from "d3";
  import {
    snapToGrid,
    gridSize,
    currentFilePath,
    isUnsaved,
    showGrid,
    dualPathMode,
    secondFilePath,
    activePaths,
  } from "./stores";
  import Two from "two.js";
  import type { Path } from "two.js/src/path";
  import type { Line as PathLine } from "two.js/src/shapes/line";
  import ControlTab from "./lib/ControlTab.svelte";
  import Navbar from "./lib/Navbar.svelte";
  import MathTools from "./lib/MathTools.svelte";
  import PlayIcon from "./lib/components/icons/PlayIcon.svelte";
  import PauseIcon from "./lib/components/icons/PauseIcon.svelte";
  import SaveDialog from "./lib/components/SaveDialog.svelte";
  import DualPathSaveDialog from "./lib/components/DualPathSaveDialog.svelte";
  import ProgressDialog from "./lib/components/ProgressDialog.svelte";
  import _ from "lodash";
  import hotkeys from "hotkeys-js";
  import { createAnimationController } from "./utils/animation";
  import { createPerfSampler, sampleNodeCounts } from "./utils/perf";
  import { calculatePathTime, getAnimationDuration } from "./utils";
  import { exportAsGif, downloadBlob } from "./utils/gifExporter";

  import {
    calculateRobotState,
    generateGhostPathPoints,
    generateOnionLayers,
  } from "./utils";
  import { normalizeFieldPoints, renderFieldPoints, type FieldPoint } from "./utils/fieldPoints";
  import {
    easeInOutQuad,
    getCurvePoint,
    getRandomColor,
    quadraticToCubic,
    radiansToDegrees,
    shortestRotation,
    downloadTrajectory,
    loadTrajectoryFromFile,
    loadRobotImage,
    updateRobotImageDisplay,
  } from "./utils";
  import {
    POINT_RADIUS,
    LINE_WIDTH,
    DEFAULT_ROBOT_WIDTH,
    DEFAULT_ROBOT_HEIGHT,
    DEFAULT_SETTINGS,
    FIELD_SIZE,
    getDefaultStartPoint,
    getDefaultLines,
    getDefaultShapes,
  } from "./config";
  import { loadSettings, saveSettings } from "./utils/settingsPersistence";
  import * as browserFileStore from "./utils/browserFileStore";
  import { onDestroy, onMount, tick } from "svelte";
  import { debounce } from "lodash";
  import { createHistory, type AppState } from "./utils/history";
  // Browser-only build: file operations use the browser file store and
  // localStorage. Electron-specific APIs have been removed.

  function normalizeLines(input: Line[]): Line[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      controlPoints: line.controlPoints || [],
      color: line.color || getRandomColor(),
      name: line.name || "",
      waitBeforeMs: Math.max(
        0,
        Number(line.waitBeforeMs ?? line.waitBefore?.durationMs ?? 0),
      ),
      waitAfterMs: Math.max(
        0,
        Number(line.waitAfterMs ?? line.waitAfter?.durationMs ?? 0),
      ),
      waitBeforeName: line.waitBeforeName ?? line.waitBefore?.name ?? "",
      waitAfterName: line.waitAfterName ?? line.waitAfter?.name ?? "",
    }));
  }

  // Canvas state
  let two: Two;
  let twoElement: HTMLDivElement;
  let fieldPointsCanvas: HTMLCanvasElement;
  let width = 0;
  let height = 0;
  const SIDE_PANEL_MIN_WIDTH = 240;
  const SIDE_PANEL_MAX_WIDTH = 620;
  const CENTER_MIN_WIDTH = 300;
  const PANEL_DIVIDER_WIDTH = 18;
  let leftPanelWidth = DEFAULT_SETTINGS.leftPanelWidth || 370;
  let rightPanelWidth = DEFAULT_SETTINGS.rightPanelWidth || 620;
  let leftPanelHidden = false;
  let rightPanelHidden = false;
  let panelResizeState:
    | { side: "left"; startX: number; startWidth: number }
    | { side: "right"; startX: number; startWidth: number }
    | null = null;
  // Robot state
  $: robotWidth = settings?.rWidth || DEFAULT_ROBOT_WIDTH;
  $: robotHeight = settings?.rHeight || DEFAULT_ROBOT_HEIGHT;
  let robotXY: BasePoint = { x: 0, y: 0 };
  let robotHeading: number = 0;
  let robotT: number | null = null;
  // Animation state
  let percent: number = 0;
  let playing = false;
  let animationFrame: number;
  let startTime: number | null = null;
  let previousTime: number | null = null;
  // Save dialog state
  let showSaveDialog = false;
  let showDualPathSaveDialog = false;
  let isSaving = false;
  // GIF export state
  let exportingGif = false;
  let gifExportProgress = 0;
  let gifExportStatus = "Preparing...";
  let cancelGifExport = false;
  // Path data
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let startPoint: Point = getDefaultStartPoint();
  let lines: Line[] = normalizeLines(getDefaultLines());
  let fieldPoints: FieldPoint[] = [];

  function normalizeLegacyFieldMap(input: Settings): Settings {
    const next = { ...input };

    if (typeof next.fieldMap === "string" && next.fieldMap.startsWith("custom||")) {
      const [, embeddedImage = ""] = next.fieldMap.split("||");
      next.fieldMap = "custom";
      if (embeddedImage && !next.customFieldImage) {
        next.customFieldImage = embeddedImage;
      }
    }

    if (!next.fieldMap) {
      next.fieldMap = DEFAULT_SETTINGS.fieldMap;
    }

    return next;
  }

  function detectMobileDevice() {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return false;
    }
    const userAgent = navigator.userAgent || "";
    // Prefer the standard, high-confidence signal when it's available.
    const mobileHint = "userAgentData" in navigator
      ? (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile ?? false
      : false;

    // Only treat a device as mobile when the user agent itself reports it.
    //
    // Previously this also used pointer/touch heuristics (coarse pointer,
    // maxTouchPoints, any-hover). Those are unreliable on modern desktops and
    // laptops, which often ship with built-in touchscreens (and embedded preview
    // iframes can report touch capability) — so they flagged real desktops as
    // mobile. Real phones/tablets always present a mobile user agent, so this
    // conservative check is sufficient and avoids false positives.
    const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk/i.test(userAgent);

    return mobileHint || uaMobile;
  }


  $: fieldMapSrc =
    settings.fieldMap === "custom"
      ? settings.customFieldImage || "/fields/decode.webp"
      : settings.fieldMap
        ? `/fields/${settings.fieldMap}`
        : "/fields/decode.webp";
  let sequence: SequenceItem[] = lines.map((ln) => ({
    kind: "path",
    lineId: ln.id!,
  }));
  const makeId = () =>
    `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let selectedLineIndex = 0;
  let selectedPointIndex = 0;
  let selectedLine: Line | null = null;
  let selectedPoint: BasePoint | null = null;
  let penToolEnabled = false;
  let penStroke: BasePoint[] = [];
  let penIsDrawing = false;
  let penGhostPath: (Path | PathLine)[] = [];
  let fieldMapLoaded = false;
  let robotImageLoaded = false;
  let lastFieldMapSrc = "";
  let lastRobotImageSrc = "";
  let isMobileBlocked = false;
  let effectiveSize = FIELD_SIZE;
  let fieldStageWidth = FIELD_SIZE;
  let fieldStageHeight = FIELD_SIZE;
  $: fieldPixelSize = Math.max(
    1,
    Math.floor(
      Math.min(fieldStageWidth || FIELD_SIZE, fieldStageHeight || FIELD_SIZE) - 16,
    ),
  );

  if (typeof window !== "undefined") {
    // Initial detection
    isMobileBlocked = detectMobileDevice();

    // Re-evaluate on viewport changes which can indicate mobile/orientation changes
    const _updateMobile = () => {
      try {
        isMobileBlocked = detectMobileDevice();
      } catch (e) {
        /* ignore */
      }
    };
    window.addEventListener("resize", _updateMobile);
    window.addEventListener("orientationchange", _updateMobile);
  }
  $: if (fieldMapSrc !== lastFieldMapSrc) {
    fieldMapLoaded = false;
    lastFieldMapSrc = fieldMapSrc;
  }

  $: if ((settings.robotImage || "/robot.png") !== lastRobotImageSrc) {
    robotImageLoaded = false;
    lastRobotImageSrc = settings.robotImage || "/robot.png";
  }

  $: initialAssetsReady = fieldMapLoaded && robotImageLoaded;
  $: if (lines.length > 0 && selectedLineIndex >= lines.length) {
    selectedLineIndex = lines.length - 1;
  }

  $: selectedLine = lines[selectedLineIndex] || null;
  $: selectedPoint =
    selectedLine && selectedPointIndex >= 0
      ? selectedPointIndex === 0
        ? selectedLine.endPoint
        : selectedLine.controlPoints[selectedPointIndex - 1] || null
      : null;
  let shapes: Shape[] = getDefaultShapes();
  let optimizingLineIds: Record<string, boolean> = {};
  let optimizingAll = false;

  // Second path data (for alliance coordination) - DEPRECATED, use additionalPaths
  let secondStartPoint: Point | null = null;
  let secondLines: Line[] = [];
  let secondSequence: SequenceItem[] = [];
  let secondShapes: Shape[] = [];

  // Multiple paths data (new system - supports up to 4 paths total)
  interface AdditionalPathData {
    filePath: string;
    startPoint: Point | null;
    lines: Line[];
    sequence: SequenceItem[];
    shapes: Shape[];
    settings: Settings;
    color?: string; // Optional custom color for this path
  }
  let additionalPaths: AdditionalPathData[] = [];

  const formatPathPoint = (value: number) =>
    Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);

  const SESSION_RECOVERY_KEY = "pedro_session_recovery_v1";

  interface SessionSnapshot {
    startPoint: Point;
    lines: Line[];
    sequence: SequenceItem[];
    shapes: Shape[];
    settings: Settings;
    currentFilePath: string | null;
    secondFilePath: string | null;
    secondStartPoint: Point | null;
    secondLines: Line[];
    secondSequence: SequenceItem[];
    secondShapes: Shape[];
    activePaths: string[];
    timestamp: string;
  }

  const history = createHistory();
  const { canUndoStore, canRedoStore } = history;
  const OPTIMIZER_BASE_URL = "https://fpa.pedropathing.com";

  function clampFieldCoordinate(value: number): number {
    return clamp(value, 0, FIELD_SIZE);
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
  function distanceBetweenPoints(a: BasePoint, b: BasePoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  
  function perpendicularDistance(
    point: BasePoint,
    lineStart: BasePoint,
    lineEnd: BasePoint,
  ): number {
    const denominator = Math.hypot(lineEnd.x - lineStart.x, lineEnd.y - lineStart.y);
    if (denominator === 0) {
      return distanceBetweenPoints(point, lineStart);
    }
  
    const numerator = Math.abs(
      (lineEnd.y - lineStart.y) * point.x -
        (lineEnd.x - lineStart.x) * point.y +
        lineEnd.x * lineStart.y -
        lineEnd.y * lineStart.x,
    );
  
    return numerator / denominator;
  }
  
  function simplifyStrokePoints(points: BasePoint[], tolerance: number): BasePoint[] {
    if (points.length <= 2) return points.map((point) => ({ ...point }));
  
    const simplifyRange = (startIndex: number, endIndex: number): BasePoint[] => {
      let maxDistance = 0;
      let farthestIndex = -1;
  
      for (let index = startIndex + 1; index < endIndex; index += 1) {
        const distance = perpendicularDistance(points[index], points[startIndex], points[endIndex]);
        if (distance > maxDistance) {
          maxDistance = distance;
          farthestIndex = index;
        }
      }
  
      if (maxDistance <= tolerance || farthestIndex === -1) {
        return [{ ...points[startIndex] }, { ...points[endIndex] }];
      }
  
      const left = simplifyRange(startIndex, farthestIndex);
      const right = simplifyRange(farthestIndex, endIndex);
      return [...left.slice(0, -1), ...right];
    };
  
    return simplifyRange(0, points.length - 1);
  }
  
  function dedupeStrokePoints(points: BasePoint[], minDistance: number): BasePoint[] {
    const deduped: BasePoint[] = [];
  
    for (const point of points) {
      const lastPoint = deduped[deduped.length - 1];
      if (!lastPoint || distanceBetweenPoints(lastPoint, point) >= minDistance) {
        deduped.push({ ...point });
      }
    }
  
    return deduped;
  }

  function getPointOnStroke(points: BasePoint[], targetDistance: number): BasePoint {
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return { ...points[0] };

    let remaining = targetDistance;

    for (let index = 0; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      const segmentLength = distanceBetweenPoints(current, next);

      if (segmentLength === 0) continue;
      if (remaining <= segmentLength) {
        const ratio = remaining / segmentLength;
        return {
          x: current.x + (next.x - current.x) * ratio,
          y: current.y + (next.y - current.y) * ratio,
        };
      }

      remaining -= segmentLength;
    }

    return { ...points[points.length - 1] };
  }

  function sampleStrokeControlPoints(points: BasePoint[], controlPointCount: number): BasePoint[] {
    if (points.length < 2 || controlPointCount <= 0) return [];

    const totalLength = points.reduce((sum, point, index) => {
      if (index === 0) return 0;
      return sum + distanceBetweenPoints(points[index - 1], point);
    }, 0);

    if (totalLength === 0) return [];

    const sampled: BasePoint[] = [];
    for (let index = 1; index <= controlPointCount; index += 1) {
      const targetDistance = (totalLength * index) / (controlPointCount + 1);
      sampled.push(getPointOnStroke(points, targetDistance));
    }

    return sampled;
  }
  
  function fitStrokeToLines(
    stroke: BasePoint[],
    startAnchor?: BasePoint,
  ): { startPoint: Point; lines: Line[] } | null {
    const cleanedStroke = dedupeStrokePoints(
      stroke.map((point) => ({
        x: clampFieldCoordinate(point.x),
        y: clampFieldCoordinate(point.y),
      })),
      0.25,
    );
  
    if (cleanedStroke.length < 2) return null;
  
    const simplifiedStroke = simplifyStrokePoints(cleanedStroke, 0.45);
    const strokePoints = dedupeStrokePoints(simplifiedStroke, 0.05);
  
    if (strokePoints.length < 2) return null;
  
      const maxControlPoints = Math.max(0, Math.round(Number(settings?.penToolAccuracy ?? DEFAULT_SETTINGS.penToolAccuracy)));
      const controlPointsSource = startAnchor
        ? [
            { x: clampFieldCoordinate(startAnchor.x), y: clampFieldCoordinate(startAnchor.y) },
            ...strokePoints,
          ]
        : strokePoints;
      const controlPoints = sampleStrokeControlPoints(controlPointsSource, maxControlPoints);

      const fittedLines: Line[] = [
        {
          id: makeId(),
          name: "Path 1",
          endPoint: {
            x: strokePoints[strokePoints.length - 1].x,
            y: strokePoints[strokePoints.length - 1].y,
            heading: "tangential",
            reverse: false,
          },
          controlPoints,
          color: getRandomColor(),
          waitBeforeMs: 0,
          waitAfterMs: 0,
          waitBeforeName: "",
          waitAfterName: "",
        },
      ];
  
    return {
      startPoint: {
          x: (startAnchor?.x ?? strokePoints[0].x),
          y: (startAnchor?.y ?? strokePoints[0].y),
        heading: "tangential",
        reverse: false,
      },
      lines: fittedLines,
    };
  }
  
  function commitPenStroke() {
      const selectedLine = lines[selectedLineIndex];
      const startAnchor = selectedLine?.endPoint || undefined;
      const fitted = fitStrokeToLines(penStroke, startAnchor);
    penStroke = [];
    penIsDrawing = false;
  
    if (!fitted) return;
  
      const newLine = fitted.lines[0];
      if (!newLine) return;

      if (selectedLine?.id) {
        const insertAt = lines.findIndex((line) => line.id === selectedLine.id);
        const nextLines = [...lines];
        nextLines.splice(insertAt >= 0 ? insertAt + 1 : nextLines.length, 0, newLine);
        lines = normalizeLines(nextLines);

        const nextSequence = [...sequence];
        const seqIndex = sequence.findIndex((item) => item.kind === "path" && item.lineId === selectedLine.id);
        nextSequence.splice(seqIndex >= 0 ? seqIndex + 1 : nextSequence.length, 0, { kind: "path", lineId: newLine.id! });
        sequence = nextSequence;

        selectedLineIndex = insertAt >= 0 ? insertAt + 1 : lines.length - 1;
        selectedPointIndex = 0;
      } else {
        startPoint = fitted.startPoint;
        lines = normalizeLines(fitted.lines);
        sequence = lines.map((line) => ({ kind: "path", lineId: line.id! }));
        selectedLineIndex = 0;
        selectedPointIndex = 0;
      }

    selectedPointIndex = 0;
    recordChange();
    two?.update();
  }
  
  function togglePenTool() {
    penToolEnabled = !penToolEnabled;
    if (!penToolEnabled) {
      penStroke = [];
      penIsDrawing = false;
    }
  }

  function clampPanelWidth(
    side: "left" | "right",
    desiredWidth: number,
    availableWidth: number,
    otherPanelWidth: number,
  ) {
    const rightPanelMinWidth = Math.max(
      0,
      Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth),
    );
    const minWidth = side === "right" ? rightPanelMinWidth : SIDE_PANEL_MIN_WIDTH;
    // Calculate the minimum center width needed to make the field square or wider.
    // The field height is determined by the center-stage layout, roughly:
    // window height - navbar (~80px) - ui-shell padding (~24px) - center-stage padding (~20px) - field-stage padding (~16px)
    const estimatedFieldHeight = Math.max(
      300,
      window.innerHeight - 80 - 24 - 20 - 16 - PANEL_DIVIDER_WIDTH * 2
    );
    // Center must be at least as wide as the field height to avoid a tall rectangle
    const minCenterWidthForSquare = estimatedFieldHeight;
    // Maximum panel width is constrained so center is at least minCenterWidthForSquare
    const maxPanelWidth = availableWidth - otherPanelWidth - minCenterWidthForSquare - PANEL_DIVIDER_WIDTH * 2;
    // Panel cannot exceed maxPanelWidth, but must be at least minWidth
    // If maxPanelWidth < minWidth, the panel will be shrunk to fit (making center bigger)
    const effectiveMax = Math.max(minWidth, Math.min(SIDE_PANEL_MAX_WIDTH, maxPanelWidth));
    return clamp(desiredWidth, minWidth, effectiveMax);
  }

  // Calculate the minimum center width needed for a square-or-wider field
  function getMinCenterWidthForSquare(): number {
    // Estimate field height: window height minus navbar, padding, and dividers
    const estimatedFieldHeight = Math.max(
      300,
      window.innerHeight - 80 - 24 - 20 - 16 - PANEL_DIVIDER_WIDTH * 2
    );
    return estimatedFieldHeight;
  }

  // Reactive center width calculation for the field constraint
  $: centerWidth = Math.max(
    300,
    window.innerWidth - 24 - (leftPanelHidden ? 0 : leftPanelWidth) - (rightPanelHidden ? 0 : rightPanelWidth) - PANEL_DIVIDER_WIDTH * 2
  );

  // Calculate available width for panels after ensuring center is at least square
  // If default panel sizes would make center too small, panels auto-shrink
  $: {
    const minCenterWidth = getMinCenterWidthForSquare();
    const totalAvailable = window.innerWidth - 24 - PANEL_DIVIDER_WIDTH * 2;
    const availableForPanels = totalAvailable - minCenterWidth;
    
    // Auto-shrink left panel if needed to fit
    if (!leftPanelHidden) {
      const rightMinWidth = Math.max(0, Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth));
      const rightWidth = rightPanelHidden ? 0 : Math.max(rightPanelWidth, rightMinWidth);
      const maxLeft = Math.max(SIDE_PANEL_MIN_WIDTH, availableForPanels - rightWidth);
      const desiredLeft = Number(settings?.leftPanelWidth ?? DEFAULT_SETTINGS.leftPanelWidth ?? 240);
      leftPanelWidth = clamp(desiredLeft, SIDE_PANEL_MIN_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, maxLeft));
    }
    
    // Auto-shrink right panel if needed to fit
    if (!rightPanelHidden) {
      const leftWidth = leftPanelHidden ? 0 : leftPanelWidth;
      const rightMinWidth = Math.max(0, Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth));
      const maxRight = Math.max(rightMinWidth, availableForPanels - leftWidth);
      const desiredRight = Number(settings?.rightPanelWidth ?? DEFAULT_SETTINGS.rightPanelWidth ?? 360);
      rightPanelWidth = clamp(desiredRight, rightMinWidth, Math.max(rightMinWidth, maxRight));
    }
  }

  function beginPanelResize(side: "left" | "right", event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    panelResizeState = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? leftPanelWidth : rightPanelWidth,
    };

    if (typeof document !== "undefined") {
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
    }
  }

  function endPanelResize() {
    panelResizeState = null;

    if (typeof document !== "undefined") {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  }

  function handlePanelResize(event: MouseEvent) {
    if (!panelResizeState) return;

    const availableWidth = Math.max(0, window.innerWidth - 24);
    if (panelResizeState.side === "left") {
      const rightPanelMinWidth = Math.max(0, Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth));
      const otherWidth = rightPanelHidden ? 0 : Math.max(rightPanelWidth, rightPanelMinWidth);
      const desiredWidth = panelResizeState.startWidth + (event.clientX - panelResizeState.startX);
      leftPanelHidden = false;
      leftPanelWidth = clampPanelWidth("left", desiredWidth, availableWidth, otherWidth);
      settings.leftPanelWidth = leftPanelWidth;
    } else {
      const otherWidth = leftPanelHidden ? 0 : leftPanelWidth;
      const desiredWidth = panelResizeState.startWidth - (event.clientX - panelResizeState.startX);
      rightPanelHidden = false;
      rightPanelWidth = clampPanelWidth("right", desiredWidth, availableWidth, otherWidth);
      settings.rightPanelWidth = rightPanelWidth;
    }
  }

  function toggleLeftPanelVisibility() {
    leftPanelHidden = !leftPanelHidden;
  }

  function toggleRightPanelVisibility() {
    rightPanelHidden = !rightPanelHidden;
  }

  function getMouseFieldPoint(evt: MouseEvent): BasePoint | null {
    if (!two?.renderer?.domElement) return null;
    const rect = two.renderer.domElement.getBoundingClientRect();
    return {
      x: clampFieldCoordinate(x.invert(evt.clientX - rect.left)),
      y: clampFieldCoordinate(y.invert(evt.clientY - rect.top)),
    };
  }

  function buildProjectData(overrides: Record<string, unknown> = {}) {
    return {
      startPoint,
      lines,
      shapes,
      sequence,
      fieldPoints,
      activePaths: $activePaths,
      settings,
      version: "1.3.0",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  function getAppState(): AppState {
    return {
      startPoint,
      lines,
      shapes,
      sequence,
      settings,
      fieldPoints,
    };
  }

  // Use the stores for reactivity
  $: canUndo = $canUndoStore;
  $: canRedo = $canRedoStore;

  function recordChange() {
    history.record(getAppState());
  }

  function undoAction() {
    const prev = history.undo();
    if (prev) {
      startPoint = prev.startPoint;
      lines = prev.lines;
      shapes = prev.shapes;
      sequence = prev.sequence;
      settings = prev.settings;
      fieldPoints = prev.fieldPoints;
      isUnsaved.set(true);
      two && two.update();
    }

    // undoAction completes; no file-picker behavior here
  }

  function redoAction() {
    const next = history.redo();
    if (next) {
      startPoint = next.startPoint;
      lines = next.lines;
      shapes = next.shapes;
      sequence = next.sequence;
      settings = next.settings;
      fieldPoints = next.fieldPoints;
      isUnsaved.set(true);
      two && two.update();
    }
  }

  $: {
    // Ensure arrays are reactive when items are added/removed
    lines = lines;
    shapes = shapes;
  }

  // Two.js groups
  let lineGroup = new Two.Group();
  lineGroup.id = "line-group";
  let pointGroup = new Two.Group();
  pointGroup.id = "point-group";
  let shapeGroup = new Two.Group();
  shapeGroup.id = "shape-group";
  // Coordinate converters
  let x: d3.ScaleLinear<number, number>;

  // Animation controller
  let loopAnimation = true;
  let animationController: ReturnType<typeof createAnimationController>;
  $: timePrediction = calculatePathTime(startPoint, lines, settings, sequence);
  $: animationDuration = getAnimationDuration(timePrediction.totalTime / 1000);
  
  // Second path timeline (for dual path mode)
  $: secondTimePrediction = $dualPathMode && secondStartPoint && secondLines.length > 0 
    ? calculatePathTime(secondStartPoint, secondLines, settings, secondSequence)
    : null;
  
  // Calculate max duration across all paths for playbar scaling
  $: effectiveAnimationDuration = (() => {
    // In multi-path mode, only use additional paths for duration
    if ($activePaths.length > 0) {
      let maxTime = 0;
      additionalPaths.forEach((pathData) => {
        if (pathData.startPoint && pathData.lines.length > 0) {
          const pathTime = calculatePathTime(
            pathData.startPoint,
            pathData.lines,
            pathData.settings,
            pathData.sequence
          );
          if (pathTime) {
            maxTime = Math.max(maxTime, pathTime.totalTime);
          }
        }
      });
      return maxTime > 0 ? getAnimationDuration(maxTime / 1000) : animationDuration;
    }
    
    // In normal/dual mode, check main path and second path
    let maxTime = timePrediction.totalTime;
    
    if ($dualPathMode && secondTimePrediction) {
      maxTime = Math.max(maxTime, secondTimePrediction.totalTime);
    }
    
    return getAnimationDuration(maxTime / 1000);
  })();

  $: pathPreviewItems = lines.slice(0, 14).map((line, idx) => ({
    index: idx + 1,
    lineIndex: idx,
    name: line.name || `Path ${idx + 1}`,
    x: formatPathPoint(line.endPoint.x),
    y: formatPathPoint(line.endPoint.y),
  }));
  
  // Load additional paths when activePaths changes
  $: {
    loadAdditionalPaths($activePaths);
  }

  async function loadAdditionalPaths(paths: string[]) {
    const newAdditionalPaths: AdditionalPathData[] = [];
    
    // Multi-path mode is isolated - turn off old dual path mode
    if (paths.length > 0) {
      dualPathMode.set(false);
      secondStartPoint = null;
      secondLines = [];
      secondShapes = [];
      secondSequence = [];
      secondFilePath.set(null);
    }
    
    const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A']; // Red, Teal, Blue, Salmon

    for (let i = 0; i < Math.min(paths.length, 4); i++) {
      const filePath = paths[i];
      try {
        const content = await browserFileStore.readFile(filePath);
        const data = JSON.parse(content);

        if (data.startPoint && data.lines) {
          const normalizedLines = normalizeLines(data.lines || []);
          newAdditionalPaths.push({
            filePath,
            startPoint: data.startPoint,
            lines: normalizedLines,
            shapes: data.shapes || [],
            sequence: data.sequence || normalizedLines.map((ln: Line) => ({
              kind: "path",
              lineId: ln.id!,
            })),
            settings: data.settings || { ...DEFAULT_SETTINGS },
            color: colors[i],
          });
        }
      } catch (error) {
        console.error(`Failed to load additional path ${filePath}:`, error);
      }
    }

    additionalPaths = newAdditionalPaths;
  }

  function buildSessionSnapshot(): SessionSnapshot {
    return {
      startPoint,
      lines,
      sequence,
      shapes,
      settings,
      currentFilePath: $currentFilePath,
      secondFilePath: $secondFilePath,
      secondStartPoint,
      secondLines,
      secondSequence,
      secondShapes,
      activePaths: $activePaths,
      timestamp: new Date().toISOString(),
    };
  }

  function restoreSessionSnapshot(): boolean {
    try {
      const raw = localStorage.getItem(SESSION_RECOVERY_KEY);
      if (!raw) return false;

      const parsed: SessionSnapshot = JSON.parse(raw);
      if (!parsed?.startPoint || !Array.isArray(parsed?.lines)) {
        return false;
      }

      startPoint = parsed.startPoint;

      const restoredLines = normalizeLines(parsed.lines || []);
      lines = restoredLines;

      sequence =
        parsed.sequence && parsed.sequence.length
          ? parsed.sequence
          : restoredLines.map((ln) => ({
              kind: "path",
              lineId: ln.id!,
            }));

      shapes = parsed.shapes || [];
      settings = normalizeLegacyFieldMap({
        ...DEFAULT_SETTINGS,
        ...(parsed.settings || {}),
      });

      currentFilePath.set(parsed.currentFilePath || null);
      secondFilePath.set(parsed.secondFilePath || null);

      secondStartPoint = parsed.secondStartPoint || null;
      secondLines = normalizeLines(parsed.secondLines || []);
      secondSequence =
        parsed.secondSequence && parsed.secondSequence.length
          ? parsed.secondSequence
          : secondLines.map((ln) => ({
              kind: "path",
              lineId: ln.id!,
            }));
      secondShapes = parsed.secondShapes || [];

      activePaths.set(parsed.activePaths || []);
      isUnsaved.set(true);

      return true;
    } catch (error) {
      console.error("Session restore failed:", error);
      return false;
    }
  }
  
  let secondRobotXY: BasePoint = { x: 0, y: 0 };
  let secondRobotHeading: number = 0;
  /**
   * Converter for X axis from inches to pixels.
   */
  $: x = d3
    .scaleLinear()
    .domain([0, FIELD_SIZE])
    .range([0, effectiveSize || FIELD_SIZE]);
  /**
   * Converter for Y axis from inches to pixels.
   */
  $: y = d3
    .scaleLinear()
    .domain([0, FIELD_SIZE])
    .range([effectiveSize || FIELD_SIZE, 0]);
  $: {
    // Ensure effectiveSize matches the smallest of width/height so the field image and grid align
    effectiveSize = Math.min(width || FIELD_SIZE, height || FIELD_SIZE);
  }
  $: points = (() => {
    let _points = [];
    
    // Only show main path points when NOT in multi-path mode
    if ($activePaths.length === 0) {
      let startPointElem = new Two.Circle(
        x(startPoint.x),
        y(startPoint.y),
        x(POINT_RADIUS),
      );
      startPointElem.id = `point-0-0`;
      startPointElem.fill = lines[0].color;
      startPointElem.noStroke();

      _points.push(startPointElem);

      lines.forEach((line, idx) => {
        if (!line || !line.endPoint) return; // Skip invalid lines or lines without endPoint
        [line.endPoint, ...line.controlPoints].forEach((point, idx1) => {
          if (idx1 > 0) {
            let pointGroup = new Two.Group();
            pointGroup.id = `point-${idx + 1}-${idx1}`;

            let pointElem = new Two.Circle(
              x(point.x),
              y(point.y),
              x(POINT_RADIUS),
            );
            pointElem.id = `point-${idx + 1}-${idx1}-background`;
            pointElem.fill = line.color;
            pointElem.stroke = selectedLineIndex === idx ? "#facc15" : line.color;
            pointElem.linewidth = x(selectedLineIndex === idx ? 0.7 : 0.25);

            let pointText = new Two.Text(
              `${idx1}`,
              x(point.x),
              y(point.y - 0.15),
            );
            pointText.id = `point-${idx + 1}-${idx1}-text`;
            pointText.size = x(1.55);
            pointText.leading = 1;
            pointText.family = "ui-sans-serif, system-ui, sans-serif";
            pointText.alignment = "center";
            pointText.baseline = "middle";
            pointText.fill = "white";
            pointText.noStroke();

            if (selectedLineIndex === idx) {
              const highlightRing = new Two.Circle(
                x(point.x),
                y(point.y),
                x(POINT_RADIUS) * 1.45,
              );
              highlightRing.id = `point-${idx + 1}-${idx1}-highlight`;
              highlightRing.fill = "transparent";
              highlightRing.stroke = selectedPointIndex === idx1 ? "#f59e0b" : "#facc15";
              highlightRing.linewidth = x(selectedPointIndex === idx1 ? 0.45 : 0.25);
              pointGroup.add(highlightRing);
            }

            pointGroup.add(pointElem, pointText);
            _points.push(pointGroup);
          } else {
            let pointElem = new Two.Circle(
              x(point.x),
              y(point.y),
              x(POINT_RADIUS),
            );
            pointElem.id = `point-${idx + 1}-${idx1}`;
            pointElem.fill = line.color;
            pointElem.stroke = selectedLineIndex === idx ? "#facc15" : line.color;
            pointElem.linewidth = x(selectedLineIndex === idx ? 0.7 : 0.25);
            if (selectedLineIndex === idx) {
              const highlightRing = new Two.Circle(
                x(point.x),
                y(point.y),
                x(POINT_RADIUS) * 1.45,
              );
              highlightRing.id = `point-${idx + 1}-${idx1}-highlight`;
              highlightRing.fill = "transparent";
              highlightRing.stroke = selectedPointIndex === idx1 ? "#f59e0b" : "#facc15";
              highlightRing.linewidth = x(selectedPointIndex === idx1 ? 0.45 : 0.25);
              _points.push(highlightRing);
            }
            _points.push(pointElem);
          }
        });
      });

      const selectedLine = lines[selectedLineIndex];
      const selectedPoint =
        selectedLine && selectedPointIndex >= 0
          ? selectedPointIndex === 0
            ? selectedLine.endPoint
            : selectedLine.controlPoints[selectedPointIndex - 1]
          : null;

      if (selectedLine && selectedPoint) {
        const selectedPointRing = new Two.Circle(
          x(selectedPoint.x),
          y(selectedPoint.y),
          x(POINT_RADIUS) * 1.7,
        );
        selectedPointRing.id = `selected-point-${selectedLineIndex}-${selectedPointIndex}`;
        selectedPointRing.fill = "transparent";
        selectedPointRing.stroke = "#facc15";
        selectedPointRing.linewidth = x(0.35);
        selectedPointRing.opacity = 0.95;
        _points.push(selectedPointRing);
      }
    }
    
    // Add obstacle vertices as draggable points
    if (settings?.experimentalFeatures?.obstacles) {
    shapes.forEach((shape, shapeIdx) => {
      shape.vertices.forEach((vertex, vertexIdx) => {
        let pointGroup = new Two.Group();
        pointGroup.id = `obstacle-${shapeIdx}-${vertexIdx}`;

        let pointElem = new Two.Circle(
          x(vertex.x),
          y(vertex.y),
          x(POINT_RADIUS),
        );
        pointElem.id = `obstacle-${shapeIdx}-${vertexIdx}-background`;
        pointElem.fill = shape.fillColor; // Match obstacle fill color
        pointElem.noStroke();

        let pointText = new Two.Text(
          `${vertexIdx + 1}`,
          x(vertex.x),
          y(vertex.y - 0.15),
        );
        pointText.id = `obstacle-${shapeIdx}-${vertexIdx}-text`;
        pointText.size = x(1.55);
        pointText.leading = 1;
        pointText.family = "ui-sans-serif, system-ui, sans-serif";
        pointText.alignment = "center";
        pointText.baseline = "middle";
        pointText.fill = "white";
        pointText.noStroke();
        pointGroup.add(pointElem, pointText);
        _points.push(pointGroup);
      });
    });
    }

    // Add second path points (for dual path mode) - not in multi-path mode
    if ($activePaths.length === 0 && $dualPathMode && secondStartPoint && secondLines.length > 0) {
      let secondStartPointElem = new Two.Circle(
        x(secondStartPoint.x),
        y(secondStartPoint.y),
        x(POINT_RADIUS),
      );
      secondStartPointElem.id = `second-point-0-0`;
      secondStartPointElem.fill = secondLines[0]?.color || "#888";
      secondStartPointElem.noStroke();
      _points.push(secondStartPointElem);

      secondLines.forEach((line, idx) => {
        if (!line || !line.endPoint) return;
        [line.endPoint, ...line.controlPoints].forEach((point, idx1) => {
          if (idx1 > 0) {
            let pointGroup = new Two.Group();
            pointGroup.id = `second-point-${idx + 1}-${idx1}`;

            let pointElem = new Two.Circle(
              x(point.x),
              y(point.y),
              x(POINT_RADIUS),
            );
            pointElem.id = `second-point-${idx + 1}-${idx1}-background`;
            pointElem.fill = line.color;
            pointElem.noStroke();

            let pointText = new Two.Text(
              `${idx1}`,
              x(point.x),
              y(point.y - 0.15),
            );
            pointText.id = `second-point-${idx + 1}-${idx1}-text`;
            pointText.size = x(1.55);
            pointText.leading = 1;
            pointText.family = "ui-sans-serif, system-ui, sans-serif";
            pointText.alignment = "center";
            pointText.baseline = "middle";
            pointText.fill = "white";
            pointText.noStroke();

            pointGroup.add(pointElem, pointText);
            _points.push(pointGroup);
          } else {
            let pointElem = new Two.Circle(
              x(point.x),
              y(point.y),
              x(POINT_RADIUS),
            );
            pointElem.id = `second-point-${idx + 1}-${idx1}`;
            pointElem.fill = line.color;
            pointElem.noStroke();
            _points.push(pointElem);
          }
        });
      });
    }

    // Add all control points for additional paths (full editing support)
    if ($activePaths.length > 0) {
      additionalPaths.forEach((pathData, pathIdx) => {
        if (!pathData.startPoint || !pathData.lines.length) return;
        
        // Add starting point
        let startPointElem = new Two.Circle(
          x(pathData.startPoint.x),
          y(pathData.startPoint.y),
          x(POINT_RADIUS * 0.9),
        );
        startPointElem.id = `additional-path-${pathIdx}-point-0-0`;
        startPointElem.fill = pathData.color || pathData.lines[0]?.color || "#888";
        startPointElem.noStroke();
        startPointElem.opacity = 0.8;
        _points.push(startPointElem);
        
        // Add all line points and control points
        pathData.lines.forEach((line, lineIdx) => {
          if (!line || !line.endPoint) return;
          
          [line.endPoint, ...line.controlPoints].forEach((point, pointIdx) => {
            if (pointIdx > 0) {
              // Control point with number
              let pointGroup = new Two.Group();
              pointGroup.id = `additional-path-${pathIdx}-point-${lineIdx + 1}-${pointIdx}`;

              let pointElem = new Two.Circle(
                x(point.x),
                y(point.y),
                x(POINT_RADIUS * 0.9),
              );
              pointElem.id = `additional-path-${pathIdx}-point-${lineIdx + 1}-${pointIdx}-background`;
              pointElem.fill = pathData.color || line.color;
              pointElem.noStroke();

              let pointText = new Two.Text(
                `${pointIdx}`,
                x(point.x),
                y(point.y - 0.15),
              );
              pointText.id = `additional-path-${pathIdx}-point-${lineIdx + 1}-${pointIdx}-text`;
              pointText.size = x(1.4);
              pointText.leading = 1;
              pointText.family = "ui-sans-serif, system-ui, sans-serif";
              pointText.alignment = "center";
              pointText.baseline = "middle";
              pointText.fill = "white";
              pointText.noStroke();

              pointGroup.add(pointElem, pointText);
              pointGroup.opacity = 0.8;
              _points.push(pointGroup);
            } else {
              // End point without number
              let pointElem = new Two.Circle(
                x(point.x),
                y(point.y),
                x(POINT_RADIUS * 0.9),
              );
              pointElem.id = `additional-path-${pathIdx}-point-${lineIdx + 1}-${pointIdx}`;
              pointElem.fill = pathData.color || line.color;
              pointElem.noStroke();
              pointElem.opacity = 0.8;
              _points.push(pointElem);
            }
          });
        });
      });
    }

    return _points;
  })();

  $: path = (() => {
    // Hide main path when in multi-path mode (isolated visualization)
    if ($activePaths.length > 0) {
      return [];
    }
    
    let _path: (Path | PathLine)[] = [];

    lines.forEach((line, idx) => {
      if (!line || !line.endPoint) return; // Skip invalid lines or lines without endPoint
      let _startPoint =
        idx === 0 ? startPoint : lines[idx - 1]?.endPoint || null;
      if (!_startPoint) return; // Skip if previous line's endPoint is missing

      let lineElem: Path | PathLine;
      if (line.controlPoints.length > 2) {
        // Approximate an n-degree bezier curve by sampling it at 100 points
        const samples = 100;
        const cps = [_startPoint, ...line.controlPoints, line.endPoint];
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        ];
        for (let i = 1; i <= samples; ++i) {
          const point = getCurvePoint(i / samples, cps);
          points.push(
            new Two.Anchor(
              x(point.x),
              y(point.y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }
        points.forEach((point) => (point.relative = false));
        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else if (line.controlPoints.length > 0) {
        let cp1 = line.controlPoints[1]
          ? line.controlPoints[0]
          : quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
              .Q1;
        let cp2 =
          line.controlPoints[1] ??
          quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
            .Q2;
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            x(_startPoint.x),
            y(_startPoint.y),
            x(cp1.x),
            y(cp1.y),
            Two.Commands.move,
          ),
          new Two.Anchor(
            x(line.endPoint.x),
            y(line.endPoint.y),
            x(cp2.x),
            y(cp2.y),
            x(line.endPoint.x),
            y(line.endPoint.y),
            Two.Commands.curve,
          ),
        ];
        points.forEach((point) => (point.relative = false));

        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else {
        lineElem = new Two.Line(
          x(_startPoint.x),
          y(_startPoint.y),
          x(line.endPoint.x),
          y(line.endPoint.y),
        );
      }

      lineElem.id = `line-${idx + 1}`;
      lineElem.stroke = line.color;
      lineElem.linewidth = x(LINE_WIDTH);
      lineElem.noFill();
      // Add a dashed line for locked paths
      const baseOpacity = settings.pathOpacity || 1.0;
      if (line.locked) {
        lineElem.dashes = [x(2), x(2)];
        lineElem.opacity = baseOpacity * 0.7;
      } else {
        lineElem.dashes = [];
        lineElem.opacity = baseOpacity;
      }

      _path.push(lineElem);
    });

    return _path;
  })();

  // Second path rendering (for dual path mode)
  $: secondPath = (() => {
    // Don't show second path when in multi-path mode (use activePaths instead)
    if ($activePaths.length > 0 || !$dualPathMode || !secondStartPoint || secondLines.length === 0) {
      return [];
    }

    let _path: (Path | PathLine)[] = [];

    secondLines.forEach((line, idx) => {
      if (!line || !line.endPoint) return;
      let _startPoint =
        idx === 0 ? secondStartPoint : secondLines[idx - 1]?.endPoint || null;
      if (!_startPoint) return;

      let lineElem: Path | PathLine;
      if (line.controlPoints.length > 2) {
        const samples = 100;
        const cps = [_startPoint, ...line.controlPoints, line.endPoint];
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        ];
        for (let i = 1; i <= samples; ++i) {
          const point = getCurvePoint(i / samples, cps);
          points.push(
            new Two.Anchor(
              x(point.x),
              y(point.y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }
        points.forEach((point) => (point.relative = false));
        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else if (line.controlPoints.length > 0) {
        let cp1 = line.controlPoints[1]
          ? line.controlPoints[0]
          : quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
              .Q1;
        let cp2 =
          line.controlPoints[1] ??
          quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
            .Q2;
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            x(_startPoint.x),
            y(_startPoint.y),
            x(cp1.x),
            y(cp1.y),
            Two.Commands.move,
          ),
          new Two.Anchor(
            x(line.endPoint.x),
            y(line.endPoint.y),
            x(cp2.x),
            y(cp2.y),
            x(line.endPoint.x),
            y(line.endPoint.y),
            Two.Commands.curve,
          ),
        ];
        points.forEach((point) => (point.relative = false));

        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else {
        lineElem = new Two.Line(
          x(_startPoint.x),
          y(_startPoint.y),
          x(line.endPoint.x),
          y(line.endPoint.y),
        );
      }

      lineElem.id = `second-line-${idx + 1}`;
      lineElem.stroke = line.color;
      lineElem.linewidth = x(LINE_WIDTH);
      lineElem.noFill();
      const baseOpacity = settings.pathOpacity || 1.0;
      if (line.locked) {
        lineElem.dashes = [x(2), x(2)];
        lineElem.opacity = baseOpacity * 0.7;
      } else {
        lineElem.dashes = [];
        lineElem.opacity = baseOpacity;
      }

      _path.push(lineElem);
    });

    return _path;
  })();

  // Render all additional paths
  $: additionalPathElements = additionalPaths.map((pathData, pathIdx) => {
    if (!pathData.startPoint || pathData.lines.length === 0) {
      return [];
    }

    let _path: (Path | PathLine)[] = [];
    // All paths should be clearly visible - only slight opacity variation
    const pathOpacityBase = settings.pathOpacity || 1.0;
    const opacity = (1.0 - (pathIdx * 0.1)) * pathOpacityBase;

    pathData.lines.forEach((line, idx) => {
      if (!line || !line.endPoint) return;
      let _startPoint =
        idx === 0 ? pathData.startPoint : pathData.lines[idx - 1]?.endPoint || null;
      if (!_startPoint) return;

      let lineElem: Path | PathLine;
      if (line.controlPoints.length > 2) {
        const samples = 100;
        const cps = [_startPoint, ...line.controlPoints, line.endPoint];
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        ];
        for (let i = 1; i <= samples; ++i) {
          const point = getCurvePoint(i / samples, cps);
          points.push(
            new Two.Anchor(
              x(point.x),
              y(point.y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }
        points.forEach((point) => (point.relative = false));
        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else if (line.controlPoints.length > 0) {
        let cp1 = line.controlPoints[1]
          ? line.controlPoints[0]
          : quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
              .Q1;
        let cp2 =
          line.controlPoints[1] ??
          quadraticToCubic(_startPoint, line.controlPoints[0], line.endPoint)
            .Q2;
        let points = [
          new Two.Anchor(
            x(_startPoint.x),
            y(_startPoint.y),
            x(_startPoint.x),
            y(_startPoint.y),
            x(cp1.x),
            y(cp1.y),
            Two.Commands.move,
          ),
          new Two.Anchor(
            x(line.endPoint.x),
            y(line.endPoint.y),
            x(cp2.x),
            y(cp2.y),
            x(line.endPoint.x),
            y(line.endPoint.y),
            Two.Commands.curve,
          ),
        ];
        points.forEach((point) => (point.relative = false));

        lineElem = new Two.Path(points);
        lineElem.automatic = false;
      } else {
        lineElem = new Two.Line(
          x(_startPoint.x),
          y(_startPoint.y),
          x(line.endPoint.x),
          y(line.endPoint.y),
        );
      }

      lineElem.id = `additional-path-${pathIdx}-line-${idx + 1}`;
      lineElem.stroke = pathData.color || line.color;
      lineElem.linewidth = x(LINE_WIDTH);
      lineElem.noFill();
      lineElem.opacity = opacity;

      _path.push(lineElem);
    });

    return _path;
  });

  $: penGhostPath = (() => {
    if (!penToolEnabled || !penIsDrawing || penStroke.length < 2 || $activePaths.length > 0) {
      return [];
    }

    const anchors = penStroke.map(
      (point, index) =>
        new Two.Anchor(
          x(point.x),
          y(point.y),
          0,
          0,
          0,
          0,
          index === 0 ? Two.Commands.move : Two.Commands.line,
        ),
    );
    anchors.forEach((anchor) => (anchor.relative = false));

    const ghost = new Two.Path(anchors);
    ghost.automatic = false;
    ghost.stroke = "#facc15";
    ghost.fill = "transparent";
    ghost.linewidth = x(LINE_WIDTH * 0.9);
    ghost.opacity = 0.35;
    ghost.dashes = [x(0.6), x(0.6)];
    ghost.id = "pen-ghost-path";

    return [ghost];
  })();

  $: shapeElements = (() => {
    if (!(settings?.experimentalFeatures?.obstacles ?? false)) {
      return [];
    }

    let _shapes: Path[] = [];

    shapes.forEach((shape, idx) => {
      if (shape.vertices.length >= 3) {
        // Create polygon from vertices - properly format for Two.js
        let vertices = [];

        // Start with move command for first vertex
        vertices.push(
          new Two.Anchor(
            x(shape.vertices[0].x),
            y(shape.vertices[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        );

        // Add line commands for remaining vertices
        for (let i = 1; i < shape.vertices.length; i++) {
          vertices.push(
            new Two.Anchor(
              x(shape.vertices[i].x),
              y(shape.vertices[i].y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }

        // Close the shape
        vertices.push(
          new Two.Anchor(
            x(shape.vertices[0].x),
            y(shape.vertices[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.close,
          ),
        );

        vertices.forEach((point) => (point.relative = false));

        let shapeElement = new Two.Path(vertices);
        shapeElement.id = `shape-${idx}`;
        shapeElement.stroke = shape.color;
        shapeElement.fill = shape.color;
        shapeElement.opacity = 0.4;
        shapeElement.linewidth = x(0.8);
        shapeElement.automatic = false;

        _shapes.push(shapeElement);
      }
    });

    return _shapes;
  })();

  $: ghostPathElement = (() => {
    let ghostPath: Path | null = null;

    // Don't show ghost paths in multi-path mode
    if ($activePaths.length === 0 && settings.showGhostPaths && lines.length > 0) {
      const ghostPoints = generateGhostPathPoints(
        startPoint,
        lines,
        settings.rWidth,
        settings.rHeight,
        50,
      );

      if (ghostPoints.length >= 3) {
        // Create polygon from ghost path points
        let vertices = [];

        // Start with move command for first point
        vertices.push(
          new Two.Anchor(
            x(ghostPoints[0].x),
            y(ghostPoints[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        );

        // Add line commands for remaining points
        for (let i = 1; i < ghostPoints.length; i++) {
          vertices.push(
            new Two.Anchor(
              x(ghostPoints[i].x),
              y(ghostPoints[i].y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }

        // Close the shape
        vertices.push(
          new Two.Anchor(
            x(ghostPoints[0].x),
            y(ghostPoints[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.close,
          ),
        );

        vertices.forEach((point) => (point.relative = false));

        ghostPath = new Two.Path(vertices);
        ghostPath.id = "ghost-path";
        ghostPath.stroke = "#a78bfa"; // Light purple/lavender
        ghostPath.fill = "#a78bfa";
        ghostPath.opacity = 0.15;
        ghostPath.linewidth = x(0.5);
        ghostPath.automatic = false;
      }
    }

    return ghostPath;
  })();

  // Second ghost path for dual path mode
  $: secondGhostPathElement = (() => {
    let ghostPath: Path | null = null;

    // Don't show second ghost path in multi-path mode
    if ($activePaths.length === 0 && $dualPathMode && settings.showGhostPaths && secondLines.length > 0 && secondStartPoint) {
      const ghostPoints = generateGhostPathPoints(
        secondStartPoint,
        secondLines,
        settings.rWidth,
        settings.rHeight,
        50,
      );

      if (ghostPoints.length >= 3) {
        let vertices = [];

        vertices.push(
          new Two.Anchor(
            x(ghostPoints[0].x),
            y(ghostPoints[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        );

        for (let i = 1; i < ghostPoints.length; i++) {
          vertices.push(
            new Two.Anchor(
              x(ghostPoints[i].x),
              y(ghostPoints[i].y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }

        vertices.push(
          new Two.Anchor(
            x(ghostPoints[0].x),
            y(ghostPoints[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.close,
          ),
        );

        vertices.forEach((point) => (point.relative = false));

        ghostPath = new Two.Path(vertices);
        ghostPath.id = "ghost-path-2";
        ghostPath.stroke = "#fca5a5"; // Light red/pink for second robot
        ghostPath.fill = "#fca5a5";
        ghostPath.opacity = 0.15;
        ghostPath.linewidth = x(0.5);
        ghostPath.automatic = false;
      }
    }

    return ghostPath;
  })();

  // Ghost paths for additional paths in multi-path mode
  $: additionalGhostPathElements = (() => {
    let ghostPaths: Path[] = [];

    if ($activePaths.length > 0 && settings.showGhostPaths) {
      additionalPaths.forEach((pathData, pathIdx) => {
        if (!pathData.startPoint || !pathData.lines.length) return;

        const ghostPoints = generateGhostPathPoints(
          pathData.startPoint,
          pathData.lines,
          settings.rWidth,
          settings.rHeight,
          50,
        );

        if (ghostPoints.length >= 3) {
          let vertices = [];

          vertices.push(
            new Two.Anchor(
              x(ghostPoints[0].x),
              y(ghostPoints[0].y),
              0,
              0,
              0,
              0,
              Two.Commands.move,
            ),
          );

          for (let i = 1; i < ghostPoints.length; i++) {
            vertices.push(
              new Two.Anchor(
                x(ghostPoints[i].x),
                y(ghostPoints[i].y),
                0,
                0,
                0,
                0,
                Two.Commands.line,
              ),
            );
          }

          vertices.push(
            new Two.Anchor(
              x(ghostPoints[0].x),
              y(ghostPoints[0].y),
              0,
              0,
              0,
              0,
              Two.Commands.close,
            ),
          );

          vertices.forEach((point) => (point.relative = false));

          const ghostPath = new Two.Path(vertices);
          ghostPath.id = `ghost-path-additional-${pathIdx}`;
          ghostPath.stroke = pathData.color || "#a78bfa";
          ghostPath.fill = pathData.color || "#a78bfa";
          ghostPath.opacity = 0.15;
          ghostPath.linewidth = x(0.5);
          ghostPath.automatic = false;
          
          ghostPaths.push(ghostPath);
        }
      });
    }

    return ghostPaths;
  })();

  $: onionLayerElements = (() => {
    let onionLayers: Path[] = [];

    // Don't show onion layers in multi-path mode
    if ($activePaths.length === 0 && settings.showOnionLayers && lines.length > 0) {
      const spacing = settings.onionLayerSpacing || 6;
      let layers = generateOnionLayers(
        startPoint,
        lines,
        settings.rWidth,
        settings.rHeight,
        spacing,
      );

      // If user requested onion layers only for the next point, filter to the relevant line
      if (
        settings.onionNextPointOnly &&
        timePrediction &&
        timePrediction.timeline
      ) {
        const currentTime = (timePrediction.totalTime || 0) * (percent / 100);
        const travelEvents = (timePrediction.timeline || []).filter(
          (ev) => ev.type === "travel",
        );

        let selectedLineIndex: number | null = null;

        // Current travel segment
        const currentTravel = travelEvents.find(
          (ev) => ev.startTime <= currentTime && ev.endTime >= currentTime,
        );
        if (currentTravel) {
          selectedLineIndex = currentTravel.lineIndex as number;
        } else {
          // Next upcoming travel segment
          const nextTravel = travelEvents.find(
            (ev) => ev.startTime > currentTime,
          );
          if (nextTravel) selectedLineIndex = nextTravel.lineIndex as number;
          else if (travelEvents.length)
            selectedLineIndex = travelEvents[travelEvents.length - 1]
              .lineIndex as number;
        }

        if (selectedLineIndex !== null) {
          layers = layers.filter((l: any) => l.lineIndex === selectedLineIndex);
        }
      }

      layers.forEach((layer, idx) => {
        // Create a rectangle from the robot corners
        let vertices: any[] = [];

        // Create path from corners: front-left -> front-right -> back-right -> back-left
        vertices.push(
          new Two.Anchor(
            x(layer.corners[0].x),
            y(layer.corners[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        );

        for (let i = 1; i < layer.corners.length; i++) {
          vertices.push(
            new Two.Anchor(
              x(layer.corners[i].x),
              y(layer.corners[i].y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }

        // Close the path by returning to the first corner
        vertices.push(
          new Two.Anchor(
            x(layer.corners[0].x),
            y(layer.corners[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.close,
          ),
        );

        vertices.forEach((point) => (point.relative = false));

        let onionRect = new Two.Path(vertices);
        onionRect.id = `onion-layer-${idx}`;
        onionRect.stroke = settings.onionColor || "#dc2626";
        onionRect.noFill();
        // Increase opacity so colliders are more visible
        onionRect.opacity = 0.9;
        onionRect.linewidth = x(0.28);
        onionRect.automatic = false;

        onionLayers.push(onionRect);
      });
    }

    return onionLayers;
  })();

  // Second onion layers for dual path mode
  $: secondOnionLayerElements = (() => {
    let onionLayers: Path[] = [];

    // Don't show second onion layers in multi-path mode
    if ($activePaths.length === 0 && $dualPathMode && settings.showOnionLayers && secondLines.length > 0 && secondStartPoint) {
      const spacing = settings.onionLayerSpacing || 6;
      let layers = generateOnionLayers(
        secondStartPoint,
        secondLines,
        settings.rWidth,
        settings.rHeight,
        spacing,
      );

      // If user requested onion layers only for the next point, filter to the relevant line
      if (
        settings.onionNextPointOnly &&
        secondTimePrediction &&
        secondTimePrediction.timeline
      ) {
        const currentTime = (secondTimePrediction.totalTime || 0) * (percent / 100);
        const travelEvents = (secondTimePrediction.timeline || []).filter(
          (ev) => ev.type === "travel",
        );

        let selectedLineIndex: number | null = null;

        const currentTravel = travelEvents.find(
          (ev) => ev.startTime <= currentTime && ev.endTime >= currentTime,
        );
        if (currentTravel) {
          selectedLineIndex = currentTravel.lineIndex as number;
        } else {
          const nextTravel = travelEvents.find(
            (ev) => ev.startTime > currentTime,
          );
          if (nextTravel) selectedLineIndex = nextTravel.lineIndex as number;
          else if (travelEvents.length)
            selectedLineIndex = travelEvents[travelEvents.length - 1]
              .lineIndex as number;
        }

        if (selectedLineIndex !== null) {
          layers = layers.filter((l: any) => l.lineIndex === selectedLineIndex);
        }
      }

      layers.forEach((layer, idx) => {
        let vertices: any[] = [];

        vertices.push(
          new Two.Anchor(
            x(layer.corners[0].x),
            y(layer.corners[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.move,
          ),
        );

        for (let i = 1; i < layer.corners.length; i++) {
          vertices.push(
            new Two.Anchor(
              x(layer.corners[i].x),
              y(layer.corners[i].y),
              0,
              0,
              0,
              0,
              Two.Commands.line,
            ),
          );
        }

        vertices.push(
          new Two.Anchor(
            x(layer.corners[0].x),
            y(layer.corners[0].y),
            0,
            0,
            0,
            0,
            Two.Commands.close,
          ),
        );

        vertices.forEach((point) => (point.relative = false));

        let onionRect = new Two.Path(vertices);
        onionRect.id = `second-onion-layer-${idx}`;
        onionRect.stroke = "#fca5a5"; // Light red/pink for second path
        onionRect.noFill();
        onionRect.opacity = 0.9;
        onionRect.linewidth = x(0.28);
        onionRect.automatic = false;

        onionLayers.push(onionRect);
      });
    }

    return onionLayers;
  })();

  let isLoaded = false;
  // Reactively trigger when any saveable data changes
  $: {
    if (isLoaded && (lines || shapes || startPoint || settings)) {
      isUnsaved.set(true);
    }
  }

  // Allow the app to stabilize before tracking changes
  onMount(() => {
    if (isMobileBlocked) return;

    setTimeout(() => {
      isLoaded = true;
      recordChange();
    }, 500);
  });
  onMount(async () => {
    if (isMobileBlocked) return;

    // Load saved settings
    const savedSettings = await loadSettings();
    settings = normalizeLegacyFieldMap({ ...savedSettings });

    const restored = restoreSessionSnapshot();
    if (restored) {
      console.info("Recovered previous unsaved session.");
    }

    // Update robot dimensions from loaded settings
    robotWidth = settings.rWidth;
    robotHeight = settings.rHeight;
    // Ensure panel widths obey min/max after loading settings
    clampAllPanels();
    if (typeof window !== "undefined") {
      window.addEventListener("resize", clampAllPanels);
    }
  });

  onDestroy(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", clampAllPanels);
    }
  });
  // Debounced save function
  const debouncedSaveSettings = debounce(async (settingsToSave: Settings) => {
    await saveSettings(settingsToSave);
  }, 1000);
  // Save after 1 second of inactivity

  function clampAllPanels() {
    if (typeof window === "undefined") return;
    const availableWidth = Math.max(0, window.innerWidth - 24);
    const rightPanelMinWidth = Math.max(0, Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth));
    const otherForLeft = rightPanelHidden ? 0 : Math.max(rightPanelWidth, rightPanelMinWidth);
    leftPanelWidth = clampPanelWidth("left", leftPanelWidth, availableWidth, otherForLeft);
    const otherForRight = leftPanelHidden ? 0 : leftPanelWidth;
    rightPanelWidth = clampPanelWidth("right", rightPanelWidth, availableWidth, otherForRight);
    settings.leftPanelWidth = leftPanelWidth;
    settings.rightPanelWidth = rightPanelWidth;
  }

  function maximizePanelsToAllowed() {
    if (typeof window === "undefined") return;
    const availableWidth = Math.max(0, window.innerWidth - 24);
    const rightPanelMinWidth = Math.max(
      0,
      Number(settings?.rightPanelMinWidth ?? DEFAULT_SETTINGS.rightPanelMinWidth),
    );
    const maxEach = Math.floor((availableWidth - CENTER_MIN_WIDTH - PANEL_DIVIDER_WIDTH * 2) / 2);
    const leftTarget = Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(SIDE_PANEL_MAX_WIDTH, maxEach));
    const rightTarget = Math.max(rightPanelMinWidth, Math.min(SIDE_PANEL_MAX_WIDTH, maxEach));
    leftPanelWidth = leftTarget;
    rightPanelWidth = rightTarget;
    settings.leftPanelWidth = leftPanelWidth;
    settings.rightPanelWidth = rightPanelWidth;
  }

  const debouncedSaveSession = debounce((snapshot: SessionSnapshot) => {
    try {
      localStorage.setItem(SESSION_RECOVERY_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Session snapshot save failed:", error);
    }
  }, 750);

  // Watch for settings changes and save
  $: {
    if (settings) {
      debouncedSaveSettings(settings);
    }
  }

  $: {
    if (isLoaded) {
      debouncedSaveSession(buildSessionSnapshot());
    }
  }

  onDestroy(() => {
    debouncedSaveSession.cancel();
    debouncedSaveSettings.cancel();
    endPanelResize();
  });

  // Initialize animation controller
  onMount(() => {
    if (isMobileBlocked) return;

    animationController = createAnimationController(
      animationDuration,
      (newPercent) => {
        percent = newPercent;
      },
      () => {
        // Animation completed callback
        console.log("Animation completed");
        playing = false;
      },
    );
  });
  $: if (animationController) {
    animationController.setDuration(effectiveAnimationDuration);
  }

  $: if (animationController) {
    animationController.setLoop(loopAnimation);
    // Sync UI state with controller
    playing = animationController.isPlaying();
  }

  // Save Function
  // Save the current project into the browser-backed store (or download)
  async function saveProject() {
    try {
      await saveFile();
    } catch (e) {
      console.error("Failed to save project:", e);
      alert("Failed to save file.");
    }
  }

  // Save an additional path back to its file
  async function saveAdditionalPath(pathIdx: number) {
    const pathData = additionalPaths[pathIdx];
    if (!pathData || !pathData.filePath) return;
    
    try {
      const fileData = JSON.stringify(buildProjectData({
        startPoint: pathData.startPoint,
        lines: pathData.lines,
        shapes: pathData.shapes,
        sequence: pathData.sequence,
        settings: pathData.settings,
      }));
      
      await browserFileStore.writeFile(pathData.filePath, fileData);
      console.log(`Auto-saved additional path: ${pathData.filePath}`);
    } catch (error) {
      console.error(`Failed to save additional path ${pathData.filePath}:`, error);
      throw error;
    }
  }

  async function saveAllAdditionalPaths() {
    if ($activePaths.length === 0) return;

    for (let pathIdx = 0; pathIdx < additionalPaths.length; pathIdx += 1) {
      await saveAdditionalPath(pathIdx);
    }
  }

  // Keyboard shortcut for save
  hotkeys("cmd+s, ctrl+s", function (event, handler) {
    event.preventDefault();
    if ($activePaths.length > 0) {
      // Multiple paths mode - save all modified paths
      showDualPathSaveDialog = true;
    } else if ($dualPathMode && secondStartPoint && secondLines.length > 0) {
      showDualPathSaveDialog = true;
    } else {
      showSaveDialog = true;
    }
  });

  // Export path animation as GIF
  async function exportPathAsGif() {
    if (!twoElement || !two) {
      alert("Canvas not ready. Please try again.");
      return;
    }
    
    // Two.js can render as canvas or SVG; exporter supports both.
    const rendererElement = two.renderer.domElement;
    if (!rendererElement) {
      alert("Unable to access renderer for export.");
      return;
    }
    
    // Check if we have paths to export
    const hasActivePaths = $activePaths.length > 0;
    const hasDualPath = $dualPathMode && secondStartPoint && secondLines.length > 0;
    const hasSinglePath = lines.length > 0;
    
    if (!hasActivePaths && !hasDualPath && !hasSinglePath) {
      alert("No paths to export. Please create a path first.");
      return;
    }

    try {
      exportingGif = true;
      cancelGifExport = false;
      gifExportProgress = 0;
      gifExportStatus = "Calculating animation duration...";

      const scale = 0.65;
      const viewWidth = twoElement.clientWidth;
      const viewHeight = twoElement.clientHeight;
      const robotPixelWidth = x(robotWidth);
      const robotPixelHeight = x(robotHeight);

      const imageCache = new Map<string, HTMLImageElement>();
      const loadImage = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          if (imageCache.has(src)) {
            resolve(imageCache.get(src)!);
            return;
          }
          const image = new Image();
          image.onload = () => {
            imageCache.set(src, image);
            resolve(image);
          };
          image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
          image.src = src;
        });

      const fieldImage = await loadImage(fieldMapSrc).catch(async () => {
        return loadImage("/fields/decode.webp");
      });
      const robotImage = await loadImage(settings.robotImage || "/robot.png").catch(async () => {
        return loadImage("/robot.png");
      });

      const drawRobot = (
        ctx: CanvasRenderingContext2D,
        xy: BasePoint,
        headingDeg: number,
        opacity = 1,
      ) => {
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.translate(xy.x * scale, xy.y * scale);
        ctx.rotate((headingDeg * Math.PI) / 180);
        ctx.drawImage(
          robotImage,
          (-robotPixelWidth * scale) / 2,
          (-robotPixelHeight * scale) / 2,
          robotPixelWidth * scale,
          robotPixelHeight * scale,
        );
        ctx.restore();
      };

      // Calculate total animation duration
      let totalDuration = 0;
      
      if (hasActivePaths) {
        // Multiple paths mode - use the longest path duration
        for (const pathData of additionalPaths) {
          if (!pathData.startPoint) continue;
          const pathTime = calculatePathTime(
            pathData.startPoint,
            pathData.lines,
            pathData.settings,
            pathData.sequence
          );
          totalDuration = Math.max(totalDuration, pathTime?.totalTime || 0);
        }
      } else if (hasDualPath) {
        // Dual path mode - use the longer path
        const path1Time = calculatePathTime(startPoint, lines, settings, sequence);
        const path2Time = secondStartPoint 
          ? calculatePathTime(secondStartPoint, secondLines, settings, secondSequence)
          : { totalTime: 0 };
        totalDuration = Math.max(path1Time?.totalTime || 0, path2Time?.totalTime || 0);
      } else {
        // Single path mode
        const pathTime = calculatePathTime(startPoint, lines, settings, sequence);
        totalDuration = pathTime?.totalTime || 0;
      }

      if (totalDuration <= 0) {
        alert("Path duration is too short to export.");
        exportingGif = false;
        return;
      }

      gifExportStatus = "Preparing animation...";
      
      // Stop any playing animation and reset to start
      const wasPlaying = playing;
      pause();
      percent = 0;
      animationController.reset();
        two.update(); // Make sure Two.js renders the initial state
      await tick(); // Allow UI to update

      gifExportStatus = "Capturing frames...";
      
      // Export as GIF with manual frame control
      const durationMs = totalDuration * 1000;
      const blob = await exportAsGif({
        source: rendererElement as HTMLCanvasElement | SVGSVGElement,
        duration: durationMs,
        fps: 20, // Higher FPS for smoother animation
        quality: 15, // Slightly lower quality for smaller file size
        scale, // Lower resolution for smaller file size
        shouldCancel: () => cancelGifExport,
        onDrawBackground: (ctx, outputWidth, outputHeight) => {
          ctx.drawImage(fieldImage, 0, 0, outputWidth, outputHeight);
        },
        onDrawForeground: (ctx) => {
          if ($activePaths.length === 0) {
            drawRobot(ctx, robotXY, robotHeading, 1);
            if ($dualPathMode && secondStartPoint && secondLines.length > 0) {
              drawRobot(ctx, secondRobotXY, secondRobotHeading, 0.8);
            }
            return;
          }

          additionalRobotStates.forEach((robotState, idx) => {
            const opacity = Math.max(0.2, 1 - idx * 0.15);
            drawRobot(ctx, robotState.xy, robotState.heading, opacity);
          });
        },
        onProgress: (progress) => {
          gifExportProgress = progress;
          if (progress < 0.5) {
            gifExportStatus = `Capturing frames... ${Math.round(progress * 200)}%`;
          } else {
            gifExportStatus = `Encoding GIF... ${Math.round((progress - 0.5) * 200)}%`;
          }
        },
        onFrameAdvance: async (frameIndex, totalFrames) => {
          // Calculate the percentage for this frame
          const framePercent = (frameIndex / (totalFrames - 1)) * 100;
          
          // Update the animation to this frame
          percent = framePercent;
          animationController.seekToPercent(framePercent);
          two.update(); // Force Two.js to render
          
          // Allow UI to update before capturing
          await tick();
        },
      });

      // Reset animation
      percent = 0;
      animationController.reset();
      
      // Resume playing if it was playing before
      if (wasPlaying) {
        play();
      }

      gifExportStatus = "Saving file...";
      
      // Download the GIF
      const fileName = $currentFilePath
        ? $currentFilePath.split(/[\/\\]/).pop()?.replace(/\.pp$/, "")
        : hasActivePaths
          ? "multiple_paths"
          : hasDualPath
            ? "dual_path"
            : "path_animation";
      
      downloadBlob(blob, `${fileName}.gif`);

      exportingGif = false;
      gifExportProgress = 0;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("GIF export error:", errorMsg);
      
      // Don't show alert if user cancelled
      if (!errorMsg.includes('cancelled')) {
        alert("Failed to export GIF: " + errorMsg);
      }
      
      cancelGifExport = false;
      exportingGif = false;
      gifExportProgress = 0;
      pause();
    }
  }
  const robotPerf = createPerfSampler("robot-state");
  $: {
    // This handles both 'travel' (movement) and 'wait' (stationary rotation) events.
    // Don't show main robot in multi-path mode
    if ($activePaths.length === 0 && timePrediction && timePrediction.timeline && lines.length > 0) {
      const t0 = performance.now();
      const state = calculateRobotState(
        percent,
        timePrediction.timeline,
        lines,
        startPoint,
        settings,
        x,
        y,
      );
      robotPerf.sample(t0);
      robotXY = { x: state.x, y: state.y };
      robotHeading = state.heading;
      robotT = state.t ?? null;
    } else {
      // Fallback for initialization or empty state
      robotXY = { x: x(startPoint.x), y: y(startPoint.y) };
      robotT = null;
      // Calculate initial heading based on start point settings
      if (startPoint.heading === "linear") robotHeading = -startPoint.startDeg;
      else if (startPoint.heading === "constant")
        robotHeading = -startPoint.degrees;
      else robotHeading = 0;
    }
  }

  // Second robot state calculation (for dual path mode)
  $: {
    // Don't show second robot in multi-path mode
    if (
      $activePaths.length === 0 &&
      $dualPathMode &&
      timePrediction &&
      secondTimePrediction &&
      secondTimePrediction.timeline &&
      secondLines.length > 0 &&
      secondStartPoint
    ) {
      // Calculate actual percent for this path based on max duration
      const maxDuration = effectiveAnimationDuration;
      const thisDuration = getAnimationDuration(secondTimePrediction.totalTime / 1000);
      const completionPercent = (thisDuration / maxDuration) * 100;
      
      // If this path should be complete, cap at 100% (robot waits at end)
      const actualPercent = Math.min(percent, completionPercent);
      const normalizedPercent = completionPercent > 0 ? (actualPercent / completionPercent) * 100 : 0;

      const state = calculateRobotState(
        normalizedPercent,
        secondTimePrediction.timeline,
        secondLines,
        secondStartPoint,
        settings,
        x,
        y,
      );
      secondRobotXY = { x: state.x, y: state.y };
      secondRobotHeading = state.heading;
    } else {
      // Fallback or not in dual mode
      secondRobotXY = { x: 0, y: 0 };
      secondRobotHeading = 0;
    }
  }

  // Precompute per-additional-path time predictions and their animation
  // scaling ONCE per edit (keyed by the additionalPaths array reference)
  // instead of rebuilding the full path timeline on every animation frame.
  type AdditionalPathEntry = {
    prediction: ReturnType<typeof calculatePathTime>;
    completionPercent: number;
  };
  let additionalPathCache = new Map<
    AdditionalPathData,
    AdditionalPathEntry | null
  >();
  let additionalPathCacheKey: AdditionalPathData[] | null = null;
  $: {
    if (additionalPathCacheKey !== additionalPaths) {
      additionalPathCacheKey = additionalPaths;
      const cache = new Map<AdditionalPathData, AdditionalPathEntry | null>();
      additionalPaths.forEach((pathData) => {
        if (!pathData.startPoint) {
          cache.set(pathData, null);
          return;
        }
        const prediction = calculatePathTime(
          pathData.startPoint,
          pathData.lines,
          pathData.settings,
          pathData.sequence,
        );
        if (
          !prediction ||
          !prediction.timeline ||
          pathData.lines.length === 0
        ) {
          cache.set(pathData, null);
          return;
        }
        const maxDuration = effectiveAnimationDuration;
        const thisDuration = getAnimationDuration(prediction.totalTime / 1000);
        const completionPercent =
          maxDuration > 0 ? (thisDuration / maxDuration) * 100 : 100;
        cache.set(pathData, { prediction, completionPercent });
      });
      additionalPathCache = cache;
    }
  }

  // Calculate robot states for all additional paths (cheap: uses the cached
  // per-path predictions above, only evaluating positions for the current %).
  let additionalRobotStates: Array<{ xy: BasePoint; heading: number }> = [];
  $: {
    additionalRobotStates = additionalPaths.map((pathData) => {
      const entry = additionalPathCache.get(pathData);
      if (!entry || !pathData.startPoint) {
        return {
          xy: { x: 0, y: 0 },
          heading: 0,
        };
      }

      // If this path should be complete, cap at 100% (robot waits at end)
      const actualPercent = Math.min(percent, entry.completionPercent);
      const normalizedPercent =
        entry.completionPercent > 0
          ? (actualPercent / entry.completionPercent) * 100
          : 0;

      const state = calculateRobotState(
        normalizedPercent,
        entry.prediction.timeline,
        pathData.lines,
        pathData.startPoint,
        pathData.settings,
        x,
        y,
      );

      return {
        xy: { x: state.x, y: state.y },
        heading: state.heading,
      };
    });
  }

  // Event markers removed: no runtime visualization created

  /**
   * Render the Two.js scene at most once per animation frame.
   *
   * Previously this reactive immediately cleared and rebuilt the entire scene
   * on every reactive change. During a drag, mousemove fires several times per
   * frame, so the scene (all paths, points, shapes, onion layers) was rebuilt
   * and re-rendered synchronously each event — a major source of jank. Coalescing
   * the clear/re-add/update into a single requestAnimationFrame keeps the scene
   * fully up to date while doing the heavy SVG work only once per frame.
   */
  let sceneRenderScheduled = false;
  const sceneRenderPerf = createPerfSampler("scene-render");
  function flushScene() {
    sceneRenderScheduled = false;
    if (!two) {
      return;
    }
    const t0 = performance.now();
    sampleNodeCounts("scene", twoElement);

    two.renderer.domElement.style["z-index"] = "30";
    two.renderer.domElement.style["position"] = "absolute";
    two.renderer.domElement.style["top"] = "0px";
    two.renderer.domElement.style["left"] = "0px";
    two.renderer.domElement.style["width"] = "100%";
    two.renderer.domElement.style["height"] = "100%";

    two.clear();

    two.add(...shapeElements);
    if (ghostPathElement) {
      two.add(ghostPathElement);
    }
    if (secondGhostPathElement) {
      two.add(secondGhostPathElement);
    }
    if (additionalGhostPathElements.length > 0) {
      two.add(...additionalGhostPathElements);
    }
    if (onionLayerElements.length > 0) {
      two.add(...onionLayerElements);
    }
    if (secondOnionLayerElements.length > 0) {
      two.add(...secondOnionLayerElements);
    }
    if (penGhostPath.length > 0) {
      two.add(...penGhostPath);
    }
    two.add(...path);
    if ($dualPathMode && secondPath.length > 0) {
      two.add(...secondPath);
    }
    // Add all additional paths
    if ($activePaths.length > 0) {
      additionalPathElements.forEach((pathElements) => {
        if (pathElements.length > 0) {
          two.add(...pathElements);
        }
      });
    }
    two.add(...points);

    two.update();
    sceneRenderPerf.sample(t0);
  }
  function scheduleSceneRender() {
    if (sceneRenderScheduled) {
      return;
    }
    sceneRenderScheduled = true;
    requestAnimationFrame(flushScene);
  }
  /**
   * Coalesce the reactive "commit" of a drag into a single per-frame step.
   *
   * Dragging fires several mousemove events per animation frame. Reassigning
   * reactive arrays (lines, secondLines, additionalPaths, shapes) inside the
   * handler triggers a full reactive cascade — path-time recompute, scene
   * rebuild, etc. — for *every* event. We mutate the model immediately (so the
   * data is always current) but only reassign the arrays once per frame, which
   * bounds the heavy work to at most one pass per frame instead of several.
   */
  let dragCommitScheduled = false;
  let pendingDragCommit: (() => void) | null = null;
  const dragCommitPerf = createPerfSampler("drag-commit");
  // Save additional paths a short while after the last drag event, instead of
  // writing the file on every mousemove (which is heavy: JSON.stringify + write).
  const debouncedSaveAdditionalPath = debounce((pathIdx: number) => {
    saveAdditionalPath(pathIdx).catch((err) =>
      console.error("Failed to auto-save additional path:", err),
    );
  }, 400);
  function scheduleDragCommit(commit: () => void) {
    pendingDragCommit = commit;
    if (dragCommitScheduled) {
      return;
    }
    dragCommitScheduled = true;
    requestAnimationFrame(() => {
      dragCommitScheduled = false;
      const fn = pendingDragCommit;
      pendingDragCommit = null;
      if (fn) {
        const t0 = performance.now();
        fn();
        dragCommitPerf.sample(t0);
      }
    });
  }

  $: {
    // Reference every piece of scene state so this block re-runs (and reschedules
    // the coalesced render) whenever any of it changes.
    const sceneDeps: unknown[] = [
      two,
      shapeElements,
      ghostPathElement,
      secondGhostPathElement,
      additionalGhostPathElements,
      onionLayerElements,
      secondOnionLayerElements,
      penGhostPath,
      path,
      secondPath,
      additionalPathElements,
      points,
      $dualPathMode,
      $activePaths,
    ];
    void sceneDeps;
    if (two) {
      scheduleSceneRender();
    }
  }

  $: if (fieldPointsCanvas && width > 0 && height > 0) {
    renderFieldPoints(fieldPointsCanvas, fieldPoints, x, y, width, height);
  }

  async function saveFileAs() {
    const win: any = window as any;
    await saveAllAdditionalPaths();
    const content = JSON.stringify(buildProjectData(), null, 2);

    // Prefer File System Access API if available: opens native Save dialog
    if (win.showSaveFilePicker) {
      try {
        const opts = {
          suggestedName: $currentFilePath
            ? $currentFilePath.split(/[\/]/).pop()
            : "path.pp",
          types: [
            {
              description: "Path files",
              accept: { "application/json": [".pp", ".json"] },
            },
          ],
        };

        const handle = await win.showSaveFilePicker(opts);
        if (!handle) {
          // User cancelled
          return;
        }

        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();

        // Update app state to reflect saved file
        try {
          currentFilePath.set(
            handle.name || (typeof handle === "string" ? handle : null),
          );
        } catch (e) {
          // ignore
        }
        isUnsaved.set(false);
        alert(`Saved to: ${handle.name || "selected file"}`);
        return;
      } catch (err) {
        console.error("SaveFilePicker error:", err);
        // fall through to download fallback
      }
    }

    // If showSaveFilePicker is not available or failed, try showOpenFilePicker to let user pick an existing file to overwrite
    if (win.showOpenFilePicker) {
      try {
        const [handle] = await win.showOpenFilePicker({
          types: [
            {
              description: "Path files",
              accept: { "application/json": [".pp", ".json"] },
            },
          ],
          multiple: false,
        });

        if (handle) {
          const writable = await handle.createWritable();
          await writable.write(content);
          await writable.close();
          try {
            currentFilePath.set(handle.name || null);
          } catch (e) {}
          isUnsaved.set(false);
          alert(`Saved to local file: ${handle.name || "selected file"}`);
          return;
        }
      } catch (err) {
        console.error("showOpenFilePicker error:", err);
        // fall through to download fallback
      }
    }

    // Fallback for browsers without File System Access (e.g., Firefox).
    // Automatically save into the app's browser-backed storage to avoid forcing a download.
    try {
      await saveFile();
      alert(
        "Your browser does not support native file dialogs. The project was saved to the app's storage.\n\nOpen the File Manager to download or export the file to your computer.",
      );
    } catch (err) {
      console.error("Failed to save into app storage:", err);
      // As a last resort, download the file
      try {
        downloadTrajectory(startPoint, lines, shapes, sequence, $activePaths);
      } catch (err2) {
        console.error("Save As fallback failed:", err2);
        alert(
          "Failed to save file. Your browser may not support file picker APIs.",
        );
      }
    }
  }

  function animate(timestamp: number) {
    if (!startTime) {
      startTime = timestamp;
    }

    if (previousTime !== null) {
      const deltaTime = timestamp - previousTime;
      if (percent >= 100) {
        percent = 0;
      } else {
        percent += (0.65 / lines.length) * (deltaTime * 0.1);
      }
    }

    previousTime = timestamp;

    if (playing) {
      requestAnimationFrame(animate);
    }
  }

  function play() {
    animationController.play();
    playing = true;
  }

  function pause() {
    animationController.pause();
    playing = false;
  }

  function resetAnimation() {
    animationController.reset();
    playing = false;
  }

  // Handle slider changes
  function handleSeek(newPercent: number) {
    if (animationController) {
      animationController.seekToPercent(newPercent);
    }
  }

  onMount(() => {
    two = new Two({
      fitted: true,
      type: Two.Types.svg,
    }).appendTo(twoElement);

    updateRobotImageDisplay();

    let currentElem: string | null = null;
    let isDown = false;
    let dragOffset = { x: 0, y: 0 }; // Store offset to prevent snapping to center
    const getPathPointLockedState = (lineIdx: number, pointIdx: number): boolean => {
      const line = lines[lineIdx];
      if (!line) return false;
      if (pointIdx === 0) {
        return !!line.endPoint?.locked;
      }
      return !!line.controlPoints[pointIdx - 1]?.locked;
    };

    const isLockedPathElem = (id: string | null): boolean => {
      if (!id || !id.startsWith("point")) return false;
      const parts = id.split("-");
      const lineIdx = Number(parts[1]) - 1;
      const pointIdx = Number(parts[2]);
      if (Number.isNaN(lineIdx)) return false;
      if (lineIdx < 0) return false; // startPoint currently not lockable
      if (Number.isNaN(pointIdx)) return !!lines[lineIdx]?.locked;
      return !!lines[lineIdx]?.locked || getPathPointLockedState(lineIdx, pointIdx);
    };

    const getPreferredPointElemId = (clientX: number, clientY: number): string | null => {
      const elements = Array.from(document.elementsFromPoint(clientX, clientY));
      const pointIds = elements
        .map((element) => (element as HTMLElement).id || "")
        .filter((id) => /^point-\d+-\d+$/.test(id));

      if (pointIds.length === 0) return null;

      const selectedPrefix = `point-${selectedLineIndex + 1}-`;
      const preferred = pointIds.find((id) => id.startsWith(selectedPrefix));
      return preferred || pointIds[0];
    };

    two.renderer.domElement.addEventListener("mousemove", (evt: MouseEvent) => {
      const elem = document.elementFromPoint(evt.clientX, evt.clientY);
      const preferredPointElemId = getPreferredPointElemId(evt.clientX, evt.clientY);

      if (penToolEnabled) {
        two.renderer.domElement.style.cursor = "crosshair";

        if (penIsDrawing) {
          const mousePoint = getMouseFieldPoint(evt);
          if (!mousePoint) return;

          const lastPoint = penStroke[penStroke.length - 1];
          if (!lastPoint || distanceBetweenPoints(lastPoint, mousePoint) >= 0.35) {
            penStroke = [...penStroke, mousePoint];
          }
        }

        return;
      }

      if (isDown && currentElem) {
        const parts = currentElem.split("-");
        const isPathPoint = parts[0] === "point";
        const isShapePoint = parts[0] === "shape";

        // Skip dragging locked paths
        if (isPathPoint) {
          const hitLine = Number(parts[1]) - 1;
          if (hitLine >= 0 && lines[hitLine]?.locked) return;
        }

        // Use simple bounding rect math to match D3 scales which are bound to clientWidth/Height
        const rect = two.renderer.domElement.getBoundingClientRect();
        const xPos = evt.clientX - rect.left;
        const yPos = evt.clientY - rect.top;

        // Get current store values for reactivity
        const currentGridSize = $gridSize;
        const currentSnapToGrid = $snapToGrid;
        const currentShowGrid = $showGrid;

        // Apply drag offset (in inches) to the raw mouse position
        let rawInchX = x.invert(xPos) + dragOffset.x;
        let rawInchY = y.invert(yPos) + dragOffset.y;

        let inchX = rawInchX;
        let inchY = rawInchY;

        // Always apply grid snapping when enabled
        if (currentSnapToGrid && currentShowGrid && currentGridSize > 0) {
          // Force snap to nearest grid point
          inchX = Math.round(rawInchX / currentGridSize) * currentGridSize;
          inchY = Math.round(rawInchY / currentGridSize) * currentGridSize;

          // Clamp to field boundaries
          inchX = Math.max(0, Math.min(FIELD_SIZE, inchX));
          inchY = Math.max(0, Math.min(FIELD_SIZE, inchY));
        }

        // Handle path point dragging
        if (settings?.experimentalFeatures?.obstacles && currentElem.startsWith("obstacle-")) {
          // Handle obstacle vertex dragging
          const parts = currentElem.split("-");
          const shapeIdx = Number(parts[1]);
          const vertexIdx = Number(parts[2]);

          shapes[shapeIdx].vertices[vertexIdx].x = inchX;
          shapes[shapeIdx].vertices[vertexIdx].y = inchY;
          // Coalesce the reactive commit to once per frame instead of per mousemove.
          scheduleDragCommit(() => {
            shapes = [...shapes];
          });
        } else if (currentElem.startsWith("second-point-")) {
          // Handle second path point dragging
          const parts = currentElem.split("-");
          const line = Number(parts[2]) - 1;
          const point = Number(parts[3]);

          if (line === -1) {
            // This is the second starting point
            if (secondStartPoint?.locked) return;
            if (secondStartPoint) {
              secondStartPoint.x = inchX;
              secondStartPoint.y = inchY;
            }
          } else if (secondLines[line]) {
            if (point === 0 && secondLines[line].endPoint) {
              secondLines[line].endPoint.x = inchX;
              secondLines[line].endPoint.y = inchY;
            } else {
              if (secondLines[line]?.locked) return;
              secondLines[line].controlPoints[point - 1].x = inchX;
              secondLines[line].controlPoints[point - 1].y = inchY;
            }
          }
          // Coalesce the reactive commit to once per frame instead of per mousemove.
          scheduleDragCommit(() => {
            secondLines = [...secondLines];
          });
        } else if (currentElem.startsWith("additional-path-")) {
          // Handle additional path point dragging
          const parts = currentElem.split("-");
          const pathIdx = Number(parts[2]);
          const line = Number(parts[4]) - 1;
          const point = Number(parts[5]);

          if (!additionalPaths[pathIdx]) return;

          if (line === -1) {
            // This is the starting point
            if (additionalPaths[pathIdx].startPoint) {
              additionalPaths[pathIdx].startPoint.x = inchX;
              additionalPaths[pathIdx].startPoint.y = inchY;
            }
          } else if (additionalPaths[pathIdx].lines[line]) {
            if (point === 0 && additionalPaths[pathIdx].lines[line].endPoint) {
              additionalPaths[pathIdx].lines[line].endPoint.x = inchX;
              additionalPaths[pathIdx].lines[line].endPoint.y = inchY;
            } else if (additionalPaths[pathIdx].lines[line].controlPoints[point - 1]) {
              additionalPaths[pathIdx].lines[line].controlPoints[point - 1].x = inchX;
              additionalPaths[pathIdx].lines[line].controlPoints[point - 1].y = inchY;
            }
          }
          // Coalesce the reactive commit to once per frame instead of per mousemove.
          scheduleDragCommit(() => {
            additionalPaths = [...additionalPaths];
          });
          // Debounce the auto-save so it fires after the drag settles instead of
          // writing the file on every mousemove.
          debouncedSaveAdditionalPath(pathIdx);
        } else {
          // Handle path point dragging
          const line = Number(currentElem.split("-")[1]) - 1;
          const point = Number(currentElem.split("-")[2]);

          if (line === -1) {
            // This is the starting point
            if (startPoint.locked) return;
            startPoint.x = inchX;
            startPoint.y = inchY;
          } else if (lines[line]) {
            if (point === 0 && lines[line].endPoint) {
              lines[line].endPoint.x = inchX;
              lines[line].endPoint.y = inchY;
            } else {
              if (lines[line]?.locked) return;
              lines[line].controlPoints[point - 1].x = inchX;
              lines[line].controlPoints[point - 1].y = inchY;
            }
          }
          // Coalesce the reactive commit to once per frame so main-path points
          // live-track the mouse while the (heavy) path/scene recompute happens
          // only once per frame instead of on every mousemove.
          scheduleDragCommit(() => {
            lines = [...lines];
          });
        }
      } else {
        if (
          ((preferredPointElemId || elem?.id)?.startsWith("point") && !isLockedPathElem(preferredPointElemId || elem?.id || null)) ||
          elem?.id.startsWith("line-") ||
          elem?.id.startsWith("second-point") ||
          elem?.id.startsWith("additional-path-") ||
          (settings?.experimentalFeatures?.obstacles && elem?.id.startsWith("obstacle"))
        ) {
          two.renderer.domElement.style.cursor = "pointer";
          currentElem = preferredPointElemId || elem?.id || null;
        } else {
          two.renderer.domElement.style.cursor = "auto";
          currentElem = null;
        }
      }
    });

    two.renderer.domElement.addEventListener("mousedown", (evt: MouseEvent) => {
      if (penToolEnabled) {
        const mousePoint = getMouseFieldPoint(evt);
        if (!mousePoint) return;

        penStroke = [mousePoint];
        penIsDrawing = true;
        currentElem = null;
        isDown = false;
        return;
      }

      const preferredPointElemId = getPreferredPointElemId(evt.clientX, evt.clientY);
      if (preferredPointElemId) {
        currentElem = preferredPointElemId;
      }

      if (currentElem && isLockedPathElem(currentElem)) {
        isDown = false;
        return;
      }

      const mousePoint = getMouseFieldPoint(evt);
      if (mousePoint && selectedLine && selectedPoint) {
        const selectedPointX = x(selectedPoint.x);
        const selectedPointY = y(selectedPoint.y);
        const selectedPointRadius = x(POINT_RADIUS) * 1.45;
        const dx = evt.clientX - (two.renderer.domElement.getBoundingClientRect().left + selectedPointX);
        const dy = evt.clientY - (two.renderer.domElement.getBoundingClientRect().top + selectedPointY);
        if (Math.hypot(dx, dy) <= selectedPointRadius) {
          currentElem = `point-${selectedLineIndex + 1}-${selectedPointIndex}`;
        }
      }

      if (currentElem?.startsWith("line-")) {
        const match = currentElem.match(/^line-(\d+)/);
        if (match) {
          selectLinePoint(Number(match[1]) - 1, 0);
        }
        isDown = false;
        return;
      }

      if (currentElem?.startsWith("point-")) {
        const match = currentElem.match(/^point-(\d+)-(\d+)/);
        if (match) {
          selectLinePoint(Number(match[1]) - 1, Number(match[2]));
        }
      }

      isDown = true;

      if (currentElem) {
        const rect = two.renderer.domElement.getBoundingClientRect();
        const mouseX = x.invert(evt.clientX - rect.left);
        const mouseY = y.invert(evt.clientY - rect.top);

        let objectX = 0;
        let objectY = 0;

        if (settings?.experimentalFeatures?.obstacles && currentElem.startsWith("obstacle-")) {
          const parts = currentElem.split("-");
          const shapeIdx = Number(parts[1]);
          const vertexIdx = Number(parts[2]);
          if (shapes[shapeIdx]?.vertices[vertexIdx]) {
            objectX = shapes[shapeIdx].vertices[vertexIdx].x;
            objectY = shapes[shapeIdx].vertices[vertexIdx].y;
          }
        } else if (currentElem.startsWith("second-point-")) {
          const parts = currentElem.split("-");
          const line = Number(parts[2]) - 1;
          const point = Number(parts[3]);

          if (line === -1) {
            if (secondStartPoint) {
              objectX = secondStartPoint.x;
              objectY = secondStartPoint.y;
            }
          } else if (secondLines[line]) {
            if (point === 0 && secondLines[line].endPoint) {
              objectX = secondLines[line].endPoint.x;
              objectY = secondLines[line].endPoint.y;
            } else if (secondLines[line].controlPoints[point - 1]) {
              objectX = secondLines[line].controlPoints[point - 1].x;
              objectY = secondLines[line].controlPoints[point - 1].y;
            }
          }
        } else if (currentElem.startsWith("additional-path-")) {
          const parts = currentElem.split("-");
          const pathIdx = Number(parts[2]);
          const line = Number(parts[4]) - 1;
          const point = Number(parts[5]);

          if (additionalPaths[pathIdx]) {
            if (line === -1) {
              // Starting point
              if (additionalPaths[pathIdx].startPoint) {
                objectX = additionalPaths[pathIdx].startPoint.x;
                objectY = additionalPaths[pathIdx].startPoint.y;
              }
            } else if (additionalPaths[pathIdx].lines[line]) {
              if (point === 0 && additionalPaths[pathIdx].lines[line].endPoint) {
                objectX = additionalPaths[pathIdx].lines[line].endPoint.x;
                objectY = additionalPaths[pathIdx].lines[line].endPoint.y;
              } else if (additionalPaths[pathIdx].lines[line].controlPoints[point - 1]) {
                objectX = additionalPaths[pathIdx].lines[line].controlPoints[point - 1].x;
                objectY = additionalPaths[pathIdx].lines[line].controlPoints[point - 1].y;
              }
            }
          }
        } else {
          const line = Number(currentElem.split("-")[1]) - 1;
          const point = Number(currentElem.split("-")[2]);

          if (line === -1) {
            objectX = startPoint.x;
            objectY = startPoint.y;
          } else if (lines[line]) {
            if (point === 0 && lines[line].endPoint) {
              objectX = lines[line].endPoint.x;
              objectY = lines[line].endPoint.y;
            } else if (lines[line].controlPoints[point - 1]) {
              objectX = lines[line].controlPoints[point - 1].x;
              objectY = lines[line].controlPoints[point - 1].y;
            }
          }
        }

        dragOffset = {
          x: objectX - mouseX,
          y: objectY - mouseY,
        };
      }
    });

    two.renderer.domElement.addEventListener("mouseup", () => {
      if (penToolEnabled) {
        if (penIsDrawing) {
          commitPenStroke();
        }
        two.renderer.domElement.style.cursor = "crosshair";
        isDown = false;
        dragOffset = { x: 0, y: 0 };
        return;
      }

      isDown = false;
      dragOffset = { x: 0, y: 0 };
      recordChange();
    });

    // Double-click on the field to create a new path at that position
    two.renderer.domElement.addEventListener("dblclick", (evt: MouseEvent) => {
      if (penToolEnabled) {
        return;
      }

      // Ignore dblclicks on existing points/lines
      const elem = document.elementFromPoint(evt.clientX, evt.clientY);
      if (
        elem?.id &&
        (elem.id.startsWith("point") ||
          (settings?.experimentalFeatures?.obstacles && elem.id.startsWith("obstacle")) ||
          elem.id.startsWith("line"))
      ) {
        return;
      }

      const rect = two.renderer.domElement.getBoundingClientRect();
      const rawInchX = x.invert(evt.clientX - rect.left);
      const rawInchY = y.invert(evt.clientY - rect.top);

      // Apply grid snapping if enabled
      const currentGridSize = $gridSize;
      const currentSnapToGrid = $snapToGrid;
      const currentShowGrid = $showGrid;

      let inchX = rawInchX;
      let inchY = rawInchY;

      if (currentSnapToGrid && currentShowGrid && currentGridSize > 0) {
        inchX = Math.round(rawInchX / currentGridSize) * currentGridSize;
        inchY = Math.round(rawInchY / currentGridSize) * currentGridSize;
      }

      // Clamp to field boundaries
      inchX = Math.max(0, Math.min(FIELD_SIZE, inchX));
      inchY = Math.max(0, Math.min(FIELD_SIZE, inchY));

      // Create a new line with endPoint at the clicked position
      const newLine: Line = {
        id: `line-${Math.random().toString(36).slice(2)}`,
        endPoint: {
          x: inchX,
          y: inchY,
          heading: "tangential",
          reverse: false,
        },
        controlPoints: [],
        color: getRandomColor(),
        locked: false,
        waitBeforeMs: 0,
        waitAfterMs: 0,
        waitBeforeName: "",
        waitAfterName: "",
      };

      lines = [...lines, newLine];
      sequence = [...sequence, { kind: "path", lineId: newLine.id! }];
      selectedLineIndex = lines.length - 1;
      recordChange();
      two.update();
    });
  });
  document.addEventListener("keydown", function (evt) {
    if (evt.code === "Space" && document.activeElement === document.body) {
      if (playing) {
        pause();
      } else {
        play();
      }
    }
  });
  async function saveFile() {
    try {
      await saveAllAdditionalPaths();
      const content = JSON.stringify(buildProjectData(), null, 2);

      if ($currentFilePath) {
        await browserFileStore.writeFile($currentFilePath, content);
        isUnsaved.set(false);
        // Provide simple feedback
        alert(`Saved to project storage: ${$currentFilePath}`);
      } else {
        // No current project file selected — save into browser cache as a new file
        const defaultName = `path_${Date.now()}.pp`;
        await browserFileStore.writeFile(defaultName, content);
        currentFilePath.set(defaultName);
        isUnsaved.set(false);
        alert(`Saved to project storage as: ${defaultName}`);
      }
    } catch (err) {
      console.error("Failed to save project to storage:", err);
      alert("Failed to save project to browser storage.");
    }
  }

  async function loadFile(evt: Event) {
    const elem = evt.target as HTMLInputElement;
    const file = elem.files?.[0];

    if (!file) return;

    const lowerName = file.name.toLowerCase();
    // Check if file is a .pp or .json file
    if (!lowerName.endsWith(".pp") && !lowerName.endsWith(".json")) {
      alert("Please select a .pp or .json file");
      // Reset the file input
      elem.value = "";
      return;
    }

    // Parse and load the uploaded file, then cache it into the browser store.
    loadTrajectoryFromFile(evt, async (data) => {
      // Ensure startPoint has all required fields
      startPoint = data.startPoint || {
        x: 72,
        y: 72,
        heading: "tangential",
        reverse: false,
      };

      // Normalize lines with all required fields
      const normalizedLines = normalizeLines(data.lines || []);
      lines = normalizedLines;

      // Derive sequence from data or create default
      sequence = (
        data.sequence && data.sequence.length
          ? data.sequence
          : normalizedLines.map((ln) => ({
              kind: "path",
              lineId: ln.id!,
            }))
      ) as SequenceItem[];
      // Load shapes with defaults
      shapes = data.shapes || [];
      fieldPoints = normalizeFieldPoints(data);
      // Load settings (including robot size) if present
      if (data.settings) {
        settings = { ...settings, ...data.settings };
        robotWidth = settings.rWidth;
        robotHeight = settings.rHeight;
      }

      activePaths.set(Array.isArray(data.activePaths) ? data.activePaths : []);

      isUnsaved.set(false);
      recordChange();

      // Cache the uploaded file into the browser-backed store for later access
      try {
        const content = JSON.stringify(data);
        await browserFileStore.writeFile(file.name, content);
        currentFilePath.set(file.name);
      } catch (err) {
        console.warn("Failed to cache uploaded file to store:", err);
      }
    });

    // Reset the file input
    elem.value = "";
  }

  // Electron file-copying logic removed — browser store and upload are used instead.

  // Helper function to load data into app state
  function loadData(data: any) {
    // Ensure startPoint has all required fields
    startPoint = data.startPoint || {
      x: 72,
      y: 72,
      heading: "tangential",
      reverse: false,
    };

    // Normalize lines with all required fields
    const normalizedLines = normalizeLines(data.lines || []);
    lines = normalizedLines;

    // Derive sequence from data or create default
    sequence = (
      data.sequence && data.sequence.length
        ? data.sequence
        : normalizedLines.map((ln) => ({
            kind: "path",
            lineId: ln.id!,
          }))
    ) as SequenceItem[];

    // Load shapes with defaults
    shapes = data.shapes || [];
    fieldPoints = normalizeFieldPoints(data);

    // Load settings (including robot size) if present
    if (data.settings) {
      settings = { ...settings, ...data.settings };
      robotWidth = settings.rWidth;
      robotHeight = settings.rHeight;
    }

    isUnsaved.set(false);
    recordChange();
  }

  function toHeadingDegrees(point: Point, position: "start" | "end"): number {
    if (!point) return 0;
    if (point.heading === "linear") {
      return position === "start" ? (point.startDeg ?? 0) : (point.endDeg ?? 0);
    }
    if (point.heading === "constant") {
      return point.degrees ?? 0;
    }
    return 0;
  }

  function buildOptimizationPayload(lineIndex: number) {
    const line = lines[lineIndex];
    if (!line) throw new Error("Line not found");

    const startPt =
      lineIndex === 0 ? startPoint : lines[lineIndex - 1]?.endPoint;
    if (!startPt) throw new Error("Missing start point for optimization");

    const waypoints = [startPt, ...line.controlPoints, line.endPoint].map(
      (p) => [p.x, p.y],
    );

    return {
      waypoints,
      start_heading_degrees: toHeadingDegrees(startPt, "start"),
      end_heading_degrees: toHeadingDegrees(line.endPoint, "end"),
      x_velocity: settings.xVelocity,
      y_velocity: settings.yVelocity,
      angular_velocity: settings.aVelocity,
      friction_coefficient: settings.kFriction,
      robot_width: settings.rWidth,
      robot_height: settings.rHeight,
      min_coord_field: 0,
      max_coord_field: FIELD_SIZE,
      interpolation:
        line.endPoint.heading === "tangential"
          ? "tangent"
          : line.endPoint.heading === "constant"
            ? "constant"
            : "linear",
      obstacles: shapes.map((shape) => shape.vertices.map((v) => [v.x, v.y])),
    };
  }

  function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async function runOptimization(payload: any) {
    const response = await fetch(`${OPTIMIZER_BASE_URL}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Optimizer request failed (${response.status}): ${errorText || response.statusText}`,
      );
    }

    const data = await response.json();
    if (data?.status === "completed" && data.result) {
      return data.result;
    }
    if (data?.status === "error") {
      throw new Error(
        `Optimization failed: ${data.message || "Unknown error"}`,
      );
    }
    throw new Error("Unexpected API response format");
  }

  async function optimizeLine(
    lineId: string,
    targetControlPointIndex?: number,
  ) {
    const lineIndex = lines.findIndex((l) => l.id === lineId);
    if (lineIndex === -1) {
      alert("Could not find line to optimize.");
      return;
    }

    if (optimizingLineIds[lineId]) return;
    optimizingLineIds = { ...optimizingLineIds, [lineId]: true };

    try {
      const payload = buildOptimizationPayload(lineIndex);
      const result = await runOptimization(payload);

      const optimizedWaypoints = Array.isArray(result?.optimized_waypoints)
        ? result.optimized_waypoints
        : Array.isArray(result)
          ? result
          : null;

      if (!optimizedWaypoints || optimizedWaypoints.length < 2) {
        throw new Error("Unexpected optimizer response format.");
      }

      const interior = optimizedWaypoints
        .slice(1, optimizedWaypoints.length - 1)
        .map((p: number[]) => ({ x: p[0], y: p[1] }));

      const newLines = [...lines];
      const current = newLines[lineIndex];

      if (typeof targetControlPointIndex === "number") {
        // Only replace the targeted control point; keep others and endpoint untouched
        const replacement =
          interior[targetControlPointIndex] ?? interior[interior.length - 1];
        if (replacement) {
          const cps = [...current.controlPoints];
          if (cps[targetControlPointIndex]) {
            cps[targetControlPointIndex] = replacement;
            newLines[lineIndex] = {
              ...current,
              controlPoints: cps,
            };
            lines = normalizeLines(newLines);
            recordChange();
          }
        }
      } else {
        // Replace entire line (control points and endpoint)
        newLines[lineIndex] = {
          ...current,
          endPoint: {
            ...current.endPoint,
            x: optimizedWaypoints[optimizedWaypoints.length - 1][0],
            y: optimizedWaypoints[optimizedWaypoints.length - 1][1],
          },
          controlPoints: interior,
        };
        lines = normalizeLines(newLines);
        recordChange();
      }
    } catch (err) {
      console.error(err);
      alert((err as Error).message || "Optimization failed.");
    } finally {
      optimizingLineIds = { ...optimizingLineIds, [lineId]: false };
    }
  }

  async function optimizeAllLines() {
    if (optimizingAll) return;
    optimizingAll = true;
    try {
      for (const ln of lines) {
        if (!ln?.id) continue;
        await optimizeLine(ln.id);
      }
    } finally {
      optimizingAll = false;
    }
  }

  function loadRobot(evt: Event) {
    const file = (evt.currentTarget as HTMLInputElement | null)?.files?.[0];
    if (!file) return;
    loadRobotImage(file, () => updateRobotImageDisplay());
  }

  function addNewLine() {
    const newLineId = `line-${Math.random().toString(36).slice(2)}`;
    lines = [
      ...lines,
      {
        id: newLineId,
        endPoint: {
          x: _.random(36, 108),
          y: _.random(36, 108),
          heading: "tangential",
          reverse: true,
        } as Point,
        controlPoints: [],
        color: getRandomColor(),
        locked: false,
        waitBeforeMs: 0,
        waitAfterMs: 0,
        waitBeforeName: "",
        waitAfterName: "",
      },
    ];
    sequence = [
      ...sequence,
      { kind: "path", lineId: newLineId },
    ];
    selectedLineIndex = lines.length - 1;
    selectedPointIndex = 0;
    recordChange();
  }

  function addControlPoint() {
    if (lines.length > 0) {
      const targetLine = lines[selectedLineIndex] || lines[lines.length - 1];
      targetLine.controlPoints.push({
        x: _.random(36, 108),
        y: _.random(36, 108),
      });
      lines = [...lines];
      selectedPointIndex = targetLine.controlPoints.length;
      recordChange();
      two?.update();
    }
  }

  function removeControlPoint() {
    if (lines.length > 0) {
      const targetLine = lines[selectedLineIndex] || lines[lines.length - 1];
      if (targetLine.controlPoints.length > 0) {
        targetLine.controlPoints.pop();
        lines = [...lines];
        selectedPointIndex = Math.min(selectedPointIndex, targetLine.controlPoints.length);
        recordChange();
        two?.update();
      }
    }
  }

  function createPathBetweenSelectedPoints() {
    const selected = lines[selectedLineIndex];
    if (!selected?.id || sequence.length === 0) return;

    const selectedSeqIndex = sequence.findIndex(
      (item) => item.kind === "path" && item.lineId === selected.id,
    );
    if (selectedSeqIndex === -1) return;

    // Use the LAST path in the sequence as the second anchor, not the next one.
    let lastPathSeqIndex = -1;
    for (let index = sequence.length - 1; index >= 0; index--) {
      if (sequence[index].kind === "path") {
        lastPathSeqIndex = index;
        break;
      }
    }

    const lastLine =
      lastPathSeqIndex >= 0
        ? lines.find((line) => line.id === (sequence[lastPathSeqIndex] as any).lineId)
        : null;

    // Start from the currently selected point (endpoint or control point) so
    // the path is created between the selection and the last point.
    const startPoint = selectedPoint || selected.endPoint;
    const endPoint = lastLine?.endPoint || {
      x: startPoint.x,
      y: startPoint.y,
      heading: "tangential",
      reverse: false,
    };
    const midpointX = (Number(startPoint.x) + Number(endPoint.x)) / 2;
    const midpointY = (Number(startPoint.y) + Number(endPoint.y)) / 2;
    const newLineId = `line-${Math.random().toString(36).slice(2)}`;

    const newLine: Line = {
      id: newLineId,
      endPoint: {
        x: midpointX,
        y: midpointY,
        heading: "tangential",
        reverse: false,
      },
      controlPoints: [],
      color: getRandomColor(),
      locked: false,
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };

    const nextLines = [...lines];
    nextLines.splice(selectedLineIndex + 1, 0, newLine);
    lines = nextLines;

    const nextSequence = [...sequence];
    nextSequence.splice(selectedSeqIndex + 1, 0, { kind: "path", lineId: newLineId });
    sequence = nextSequence;

    selectedLineIndex = selectedLineIndex + 1;
    selectedPointIndex = 0;
    recordChange();
  }

  function selectLinePoint(lineIndex: number, pointIndex = 0) {
    if (lineIndex < 0 || lineIndex >= lines.length) return;

    selectedLineIndex = lineIndex;
    const maxPointIndex = Math.max(0, lines[lineIndex]?.controlPoints.length ?? 0);
    selectedPointIndex = Math.max(0, Math.min(pointIndex, maxPointIndex));
  }

  // Keyboard shortcuts for quick path editing
  hotkeys("w", function (event, handler) {
    event.preventDefault();
    addNewLine();
  });
  hotkeys("a", function (event, handler) {
    event.preventDefault();
    addControlPoint();
    two.update();
  });
  hotkeys("s", function (event, handler) {
    event.preventDefault();
    removeControlPoint();
    two.update();
  });
  hotkeys("cmd+z, ctrl+z", function (event) {
    event.preventDefault();
    undoAction();
  });
  hotkeys("cmd+shift+z, ctrl+shift+z, ctrl+y", function (event) {
    event.preventDefault();
    redoAction();
  });
  function applyTheme(theme: "light" | "dark" | "auto") {
    let actualTheme = theme;
    if (theme === "auto") {
      // Check system preference
      if (
        window.matchMedia &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        actualTheme = "dark";
      } else {
        actualTheme = "light";
      }
    }

    if (actualTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }

  // Watch for theme changes in settings
  $: if (settings) {
    applyTheme(settings.theme);
  }

  // Watch for system theme changes if auto mode is enabled
  let mediaQuery: MediaQueryList;
  onMount(() => {
    if (isMobileBlocked) return;

    if (settings?.theme === "auto") {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleSystemThemeChange = () => {
        if (settings.theme === "auto") {
          applyTheme("auto");
        }
      };
      mediaQuery.addEventListener("change", handleSystemThemeChange);

      return () => {
        mediaQuery.removeEventListener("change", handleSystemThemeChange);
      };
    }
  });

  // Auto-export for CI/testing: if the app is loaded with URL hash #export-gif-test, automatically run GIF export once mounted
  onMount(() => {
    if (isMobileBlocked) return;

    if (
      typeof window !== "undefined" &&
      window.location &&
      window.location.hash === "#export-gif-test"
    ) {
      // Delay slightly to allow initial rendering and Two.js to initialize
      setTimeout(async () => {
        try {
          // auto GIF export removed (exportGif deleted)
          console.log("Auto GIF export skipped (exportGif removed)");
        } catch (err) {
          console.error("Auto GIF export failed:", err);
        }
      }, 1500);
    }

    // Handle save dialog event
    const handleSaveDialog = async (event: any) => {
      const { fileName } = event.detail;
      isSaving = true;
      try {
        // Create a full file path with .pp extension if not present
        const fullFileName = fileName.endsWith(".pp") ? fileName : fileName + ".pp";
        
        // Call the file manager's save function through the browser file store
        const fileData = JSON.stringify(buildProjectData());
        
        await browserFileStore.writeFile(fullFileName, fileData);
        currentFilePath.set(fullFileName);
        isUnsaved.set(false);
        
        // Show success feedback
        showSaveDialog = false;
      } catch (error) {
        console.error("Save failed:", error);
        alert("Failed to save file: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        isSaving = false;
      }
    };

    window.addEventListener("save", handleSaveDialog);

    // Handle dual path save dialog event
    const handleDualPathSave = async (event: any) => {
      const { target } = event.detail;
      isSaving = true;
      try {
        await saveAllAdditionalPaths();
        if (target === "first" && $currentFilePath) {
          const fileData = JSON.stringify(buildProjectData());
          await browserFileStore.writeFile($currentFilePath, fileData);
          isUnsaved.set(false);
        } else if (target === "second" && $secondFilePath) {
          const fileData = JSON.stringify(buildProjectData({
            startPoint: secondStartPoint,
            lines: secondLines,
            shapes: secondShapes,
            sequence: secondSequence,
          }));
          await browserFileStore.writeFile($secondFilePath, fileData);
        } else if (target === "both") {
          // Save first path
          if ($currentFilePath) {
            const fileData1 = JSON.stringify(buildProjectData());
            await browserFileStore.writeFile($currentFilePath, fileData1);
          }
          // Save second path
          if ($secondFilePath) {
            const fileData2 = JSON.stringify(buildProjectData({
              startPoint: secondStartPoint,
              lines: secondLines,
              shapes: secondShapes,
              sequence: secondSequence,
            }));
            await browserFileStore.writeFile($secondFilePath, fileData2);
          }
          isUnsaved.set(false);
        }
        showDualPathSaveDialog = false;
      } catch (error) {
        console.error("Dual path save failed:", error);
        alert("Failed to save: " + (error instanceof Error ? error.message : String(error)));
      } finally {
        isSaving = false;
      }
    };

    window.addEventListener("saveDualPath", handleDualPathSave);

    return () => {
      window.removeEventListener("save", handleSaveDialog);
      window.removeEventListener("saveDualPath", handleDualPathSave);
    };
  });
</script>

<svelte:window
  on:mousemove={handlePanelResize}
  on:mouseup={endPanelResize}
  on:blur={endPanelResize}
/>

{#if isMobileBlocked}
  <div class="flex min-h-screen w-screen items-center justify-center bg-neutral-950 px-6 text-center text-neutral-100">
    <div class="max-w-lg rounded-3xl border border-white/10 bg-neutral-900/95 px-8 py-10 shadow-2xl shadow-black/40">
      <div class="text-xs font-semibold uppercase tracking-[0.35em] text-amber-300">Desktop Required</div>
      <h1 class="mt-4 text-3xl font-semibold text-white">You need to be on a desktop for the website to function.</h1>
      <p class="mt-4 text-sm leading-6 text-neutral-300">
        This visualizer depends on mouse, keyboard, and a large workspace, so mobile devices are blocked from using it.
      </p>
      <p class="mt-3 text-xs text-neutral-500">Please reopen the site on a desktop browser.</p>
    </div>
  </div>
{:else}

<Navbar
  bind:lines
  bind:startPoint
  bind:shapes
  bind:sequence
  bind:secondStartPoint
  bind:secondLines
  bind:secondShapes
  bind:secondSequence
  bind:fieldPoints
  bind:settings
  bind:robotWidth
  bind:robotHeight
  {percent}
  {saveProject}
  {saveFileAs}
  {loadFile}
  {undoAction}
  {redoAction}
  {recordChange}
  {canUndo}
  {canRedo}
  {optimizeAllLines}
  {optimizingAll}
  {twoElement}
  bind:playing
  {play}
  {pause}
  {exportPathAsGif}
/>

<SaveDialog
  bind:isOpen={showSaveDialog}
  bind:isSaving
  fileName={$currentFilePath?.split(/[\\/]/).pop()?.replace(/\.pp$/, "") || "my_path"}
/>

<DualPathSaveDialog bind:isOpen={showDualPathSaveDialog} />

<ProgressDialog
  bind:isOpen={exportingGif}
  progress={gifExportProgress}
  statusMessage={gifExportStatus}
  onCancel={() => {
    cancelGifExport = true;
    gifExportStatus = "Cancelling...";
  }}
/>

<!--   {saveFile} -->
<div class="ui-shell w-screen h-screen pt-[5.1rem] px-3 pb-3">
  <div
    class="desktop-grid h-full"
    style={`--left-panel-width: ${leftPanelHidden ? "0px" : `${leftPanelWidth}px`}; --right-panel-width: ${rightPanelHidden ? "0px" : `${rightPanelWidth}px`}; --center-width: ${centerWidth}px;`}
  >
    <aside class="panel-box side-rail side-rail-left" class:side-rail--collapsed={leftPanelHidden}>
      <section class="module-box">
        <div class="module-header-row">
          <h3 class="module-title">File</h3>
          <div class="flex items-center gap-2">
            <span class="module-chip">v1.2.1</span>
            <button
              class="panel-toggle-btn"
              type="button"
              on:click={toggleLeftPanelVisibility}
              aria-label={leftPanelHidden ? "Show left panel" : "Hide left panel"}
              title={leftPanelHidden ? "Show left panel" : "Hide left panel"}
            >
              {leftPanelHidden ? "›" : "‹"}
            </button>
          </div>
        </div>
        <p class="module-caption">Export name</p>
        <div class="module-mono">
          {$currentFilePath?.split(/[\\/]/).pop() || "untitled_path.pp"}
        </div>
      </section>

      <section class="module-box module-fill">
        <div class="module-header-row">
          <h3 class="module-title">Path List</h3>
          <span class="module-caption">{lines.length} path{lines.length === 1 ? "" : "s"}</span>
        </div>
        <div class="module-list">
          {#each pathPreviewItems as item (item.index)}
            <button
              class="list-item-box compact text-left"
              class:list-item-box--selected={selectedLineIndex === item.lineIndex}
              on:click={() => selectLinePoint(item.lineIndex, 0)}
            >
              <div class="list-item-top">
                <span class="list-item-name">{item.name}</span>
              </div>
              <div class="list-item-sub">{item.x}, {item.y}</div>
            </button>
          {/each}
          {#if lines.length > pathPreviewItems.length}
            <div class="list-empty">+ {lines.length - pathPreviewItems.length} more...</div>
          {/if}
        </div>
      </section>
    </aside>

    <div class="panel-divider panel-divider--left">
      <button
        class="panel-divider-grip"
        type="button"
        aria-label="Resize left panel"
        title={leftPanelHidden ? "Click to restore the left panel" : "Drag to resize the left panel"}
        on:mousedown={(event) => beginPanelResize("left", event)}
        on:click={() => {
          if (leftPanelHidden) {
            leftPanelHidden = false;
          }
        }}
      >
        {#if leftPanelHidden}
          ›
        {:else}
          <span class="panel-divider-line"></span>
        {/if}
      </button>
    </div>

    <main class="panel-box center-stage">
      <div class="module-header-row mb-2">
        <h3 class="module-title">Field</h3>
        <span class="module-caption">Click a line or point to select it</span>
      </div>
      <div class="center-toolbar">
        <button class="toolbar-btn" on:click={addNewLine}>+ Add Path</button>
        <button class="toolbar-btn" class:toolbar-btn--blue={penToolEnabled} on:click={togglePenTool}>
          {penToolEnabled ? "Pen Tool On" : "Pen Tool"}
        </button>
        <button class="toolbar-btn" on:click={addControlPoint}>+ Control Point</button>
        <button class="toolbar-btn" on:click={removeControlPoint}>- Control Point</button>
        <button class="toolbar-btn toolbar-btn--blue" on:click={createPathBetweenSelectedPoints}>
          Create Path to Last Point
        </button>
        <div style="flex: 1;"></div>
        <button
          class="toolbar-btn toolbar-btn--icon"
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          on:click={() => (playing ? pause() : play())}
        >
          {#if playing}
            <PauseIcon className="size-5" strokeWidth={2} />
          {:else}
            <PlayIcon className="size-5" strokeWidth={2} />
          {/if}
        </button>
      </div>

      <div
        class="field-stage flex h-full justify-center items-center"
        bind:clientWidth={fieldStageWidth}
        bind:clientHeight={fieldStageHeight}
      >
        <div
          bind:this={twoElement}
          bind:clientWidth={width}
          bind:clientHeight={height}
          class="bg-neutral-50 dark:bg-neutral-900 relative overflow-clip"
          role="application"
          style={`width: ${fieldPixelSize}px; height: ${fieldPixelSize}px; max-width: 100%; max-height: 100%; aspect-ratio: 1 / 1; user-select: none; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; user-drag: none; -webkit-user-drag: none; -khtml-user-drag: none; -moz-user-drag: none; -ms-user-drag: none; -o-user-drag: none;`}
          on:contextmenu={(e) => e.preventDefault()}
      on:dragstart={(e) => e.preventDefault()}
      on:selectstart={(e) => e.preventDefault()}
      tabindex="-1"
        >
      <img
        src={fieldMapSrc}
        alt="Field"
        class="absolute top-0 left-0 w-full h-full rounded-lg z-10"
        style="
    background: transparent; 
    pointer-events: none; 
    user-select: none; 
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    user-drag: none;
    -webkit-user-drag: none;
    -moz-user-drag: none;
    -ms-user-drag: none;
    -o-user-drag: none;
  "
        draggable="false"
        on:load={() => (fieldMapLoaded = true)}
        on:error={(e) => {
          console.error("Failed to load field map:", settings.fieldMap);
          fieldMapLoaded = true;
          (e.currentTarget as HTMLImageElement).src = "/fields/decode.webp"; // Fallback
        }}
        on:dragstart={(e) => e.preventDefault()}
        on:selectstart={(e) => e.preventDefault()}
      />
      <canvas
        bind:this={fieldPointsCanvas}
        class="absolute top-0 left-0 w-full h-full z-15 pointer-events-none"
        aria-hidden="true"
      ></canvas>
      <MathTools {x} {y} {twoElement} {robotXY} />
      <!-- Main robot: only show in normal mode -->
      {#if $activePaths.length === 0}
        <img
          src={settings.robotImage || "/robot.png"}
          alt="Robot"
          style={`position: absolute; top: ${robotXY.y}px;
left: ${robotXY.x}px; transform: translate(-50%, -50%) rotate(${robotHeading}deg); z-index: 20; width: ${x(robotWidth)}px; height: ${x(robotHeight)}px;user-select: none; -webkit-user-select: none; -moz-user-select: none;-ms-user-select: none;
pointer-events: none;`}
          draggable="false"
          on:load={() => (robotImageLoaded = true)}
          on:error={(e) => {
            console.error("Failed to load robot image:", settings.robotImage);
            robotImageLoaded = true;
            (e.currentTarget as HTMLImageElement).src = "/robot.png"; // Fallback to default
          }}
          on:dragstart={(e) => e.preventDefault()}
          on:selectstart={(e) => e.preventDefault()}
        />
        {#if settings.showCurrentTValue && robotT !== null}
          <div
            class="pointer-events-none absolute z-22 rounded-full border border-white/20 bg-black/60 px-3.5 py-1.5 font-mono text-[22px] font-semibold leading-none tracking-wide text-white shadow-lg backdrop-blur-sm"
            style={`left: ${robotXY.x}px; top: ${robotXY.y - x(robotHeight) / 2 - 14}px; transform: translate(-50%, -100%);`}
          >
            t {robotT.toFixed(3)}
          </div>
        {/if}
        <!-- Heading arrow for main robot -->
        {#if settings.showHeadingArrow}
          <svg
            style={`position: absolute; top: ${robotXY.y}px; left: ${robotXY.x}px; z-index: 21; pointer-events: none; overflow: visible;`}
            width="1"
            height="1"
          >
            <defs>
              <marker
                id="arrowhead-main"
                markerWidth="10"
                markerHeight="10"
                refX="6.5"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 3, 0 6"
                  fill={settings.headingArrowColor || "#ffffff"}
                />
              </marker>
            </defs>
            <line
              x1="0"
              y1="0"
              x2="{(settings.headingArrowLength || 50) * Math.cos(-robotHeading * Math.PI / 180)}"
              y2="{(settings.headingArrowLength || 50) * -Math.sin(-robotHeading * Math.PI / 180)}"
              stroke={settings.headingArrowColor || "#ffffff"}
              stroke-width={settings.headingArrowThickness || 3}
              marker-end="url(#arrowhead-main)"
            />
          </svg>
        {/if}
      {/if}
      <!-- Second robot: only show in dual path mode (not multi-path mode) -->
      {#if $activePaths.length === 0 && $dualPathMode}
        <img
          src={settings.robotImage || "/robot.png"}
          alt="Robot 2"
          style={`position: absolute; top: ${secondRobotXY.y}px;
left: ${secondRobotXY.x}px; transform: translate(-50%, -50%) rotate(${secondRobotHeading}deg); z-index: 19; width: ${x(robotWidth)}px; height: ${x(robotHeight)}px;user-select: none; -webkit-user-select: none; -moz-user-select: none;-ms-user-select: none;
pointer-events: none; opacity: 0.8;`}
          draggable="false"
          on:load={() => (robotImageLoaded = true)}
          on:error={(e) => {
            console.error("Failed to load robot image:", settings.robotImage);
            robotImageLoaded = true;
            (e.currentTarget as HTMLImageElement).src = "/robot.png";
          }}
          on:dragstart={(e) => e.preventDefault()}
          on:selectstart={(e) => e.preventDefault()}
        />
        <!-- Heading arrow for second robot -->
        {#if settings.showHeadingArrow}
          <svg
            style={`position: absolute; top: ${secondRobotXY.y}px; left: ${secondRobotXY.x}px; z-index: 19; pointer-events: none; overflow: visible; opacity: 0.8;`}
            width="1"
            height="1"
          >
            <defs>
              <marker
                id="arrowhead-second"
                markerWidth="10"
                markerHeight="10"
                refX="6.5"
                refY="3"
                orient="auto"
              >
                <polygon
                  points="0 0, 7 3, 0 6"
                  fill={settings.headingArrowColor || "#ffffff"}
                />
              </marker>
            </defs>
            <line
              x1="0"
              y1="0"
              x2="{(settings.headingArrowLength || 50) * Math.cos(-secondRobotHeading * Math.PI / 180)}"
              y2="{(settings.headingArrowLength || 50) * -Math.sin(-secondRobotHeading * Math.PI / 180)}"
              stroke={settings.headingArrowColor || "#ffffff"}
              stroke-width={settings.headingArrowThickness || 3}
              marker-end="url(#arrowhead-second)"
            />
          </svg>
        {/if}
      {/if}
      <!-- Additional robots: only show in multi-path mode -->
      {#if $activePaths.length > 0}
        {#each additionalRobotStates as robotState, idx}
          <img
            src={settings.robotImage || "/robot.png"}
            alt="Robot {idx + 1}"
            style={`position: absolute; top: ${robotState.xy.y}px;
left: ${robotState.xy.x}px; transform: translate(-50%, -50%) rotate(${robotState.heading}deg); z-index: ${20 - idx}; width: ${x(robotWidth)}px; height: ${x(robotHeight)}px;user-select: none; -webkit-user-select: none; -moz-user-select: none;-ms-user-select: none;
pointer-events: none; opacity: ${1.0 - idx * 0.15};`}
            draggable="false"
            on:load={() => (robotImageLoaded = true)}
            on:error={(e) => {
              console.error("Failed to load robot image:", settings.robotImage);
              robotImageLoaded = true;
              (e.currentTarget as HTMLImageElement).src = "/robot.png";
            }}
            on:dragstart={(e) => e.preventDefault()}
            on:selectstart={(e) => e.preventDefault()}
          />
          <!-- Heading arrow for additional robots -->
          {#if settings.showHeadingArrow}
            <svg
              style={`position: absolute; top: ${robotState.xy.y}px; left: ${robotState.xy.x}px; z-index: ${20 - idx}; pointer-events: none; overflow: visible; opacity: ${1.0 - idx * 0.15};`}
              width="1"
              height="1"
            >
              <defs>
                <marker
                  id="arrowhead-{idx}"
                  markerWidth="10"
                  markerHeight="10"
                  refX="6.5"
                  refY="3"
                  orient="auto"
                >
                  <polygon
                    points="0 0, 7 3, 0 6"
                    fill={settings.headingArrowColor || "#ffffff"}
                  />
                </marker>
              </defs>
              <line
                x1="0"
                y1="0"
                x2="{(settings.headingArrowLength || 50) * Math.cos(-robotState.heading * Math.PI / 180)}"
                y2="{(settings.headingArrowLength || 50) * -Math.sin(-robotState.heading * Math.PI / 180)}"
                stroke={settings.headingArrowColor || "#ffffff"}
                stroke-width={settings.headingArrowThickness || 3}
                marker-end="url(#arrowhead-{idx})"
              />
            </svg>
          {/if}
        {/each}
      {/if}
      {#if !initialAssetsReady}
        <div class="absolute inset-0 z-60 flex items-center justify-center rounded-lg bg-neutral-950/80 backdrop-blur-sm">
          <div class="flex flex-col items-center gap-3 rounded-2xl border border-neutral-700 bg-neutral-900/95 px-6 py-5 shadow-2xl">
            <img src="/loading.svg" alt="Loading" class="size-20" draggable="false" />
            <div class="text-center">
              <div class="text-sm font-semibold text-neutral-100">Loading Visualizer</div>
              <div class="text-xs text-neutral-400">Waiting for field assets to finish loading</div>
            </div>
          </div>
        </div>
      {/if}
        </div>
      </div>
      <div class="module-footer">Field · 141.5&quot; x 141.5&quot;</div>
    </main>

    <div class="panel-divider panel-divider--right">
      <button
        class="panel-divider-grip"
        type="button"
        aria-label="Resize right panel"
        title={rightPanelHidden ? "Click to restore the right panel" : "Drag to resize the right panel"}
        on:mousedown={(event) => beginPanelResize("right", event)}
        on:click={() => {
          if (rightPanelHidden) {
            rightPanelHidden = false;
          }
        }}
      >
        {#if rightPanelHidden}
          ‹
        {:else}
          <span class="panel-divider-line"></span>
        {/if}
      </button>
    </div>

    <aside class="panel-box side-rail side-rail-right" class:side-rail--collapsed={rightPanelHidden}>
      <div class="module-box control-panel-header">
        <div class="module-header-row">
          <div>
            <h3 class="module-title">Controls</h3>
            <p class="module-caption">Edit playback, paths, and robot settings.</p>
          </div>
          <button
            class="panel-toggle-btn"
            type="button"
            on:click={toggleRightPanelVisibility}
            aria-label={rightPanelHidden ? "Show right panel" : "Hide right panel"}
            title={rightPanelHidden ? "Show right panel" : "Hide right panel"}
          >
            {rightPanelHidden ? "‹" : "›"}
          </button>
        </div>
      </div>
      <ControlTab
        bind:playing
        {play}
        {pause}
        bind:startPoint
        bind:lines
        bind:sequence
        bind:selectedLineIndex
        bind:selectedPointIndex
        bind:robotWidth
        bind:robotHeight
        bind:settings
        bind:percent
        bind:robotXY
        bind:robotHeading
        bind:shapes
        {x}
        {y}
        {handleSeek}
        bind:loopAnimation
        {recordChange}
        {optimizeLine}
        {optimizingLineIds}
      />
    </aside>
  </div>
</div>
{/if}
