import type {
  BasePoint,
  Line,
  PiecewiseHeadingInterpolation,
  PiecewiseHeadingInterpolationType,
  PiecewiseHeadingSegment,
  PathChain,
} from "../types";
import {
  getCurvePoint,
  interpolateAngleDegrees,
  normalizeAngleDegrees,
  radiansToDegrees,
} from "./math";

const MIN_SEGMENT_LENGTH = 0.0001;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clonePoint(point?: BasePoint): BasePoint | undefined {
  if (!point) return undefined;
  return {
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
    locked: point.locked,
  };
}

function defaultParameters(
  type: PiecewiseHeadingInterpolationType,
): PiecewiseHeadingSegment["parameters"] {
  switch (type) {
    case "constant":
      return { degrees: 0 };
    case "linear":
      return { startDeg: 0, endDeg: 0 };
    case "facing-point":
      return { point: { x: 0, y: 0 } };
    default:
      return undefined;
  }
}

function areParametersEqual(
  left: PiecewiseHeadingSegment["parameters"],
  right: PiecewiseHeadingSegment["parameters"],
): boolean {
  return JSON.stringify(left || {}) === JSON.stringify(right || {});
}

export function segmentSupportsReverse(
  type: PiecewiseHeadingInterpolationType,
): boolean {
  return type === "linear" || type === "tangential" || type === "facing-point";
}

export function createDefaultPiecewiseSegment(): PiecewiseHeadingSegment {
  return {
    startProgress: 0,
    endProgress: 1,
    interpolationType: "linear",
    reversed: false,
    parameters: defaultParameters("linear"),
  };
}

export function createDefaultPiecewiseHeadingInterpolation(
  scope: "path" | "chain" = "path",
): PiecewiseHeadingInterpolation {
  return {
    scope,
    segments: [createDefaultPiecewiseSegment()],
  };
}

function normalizeSegment(
  segment: PiecewiseHeadingSegment,
): PiecewiseHeadingSegment {
  const interpolationType = segment.interpolationType || "linear";
  const parameters = segment.parameters
    ? {
        ...segment.parameters,
        point: clonePoint(segment.parameters.point),
      }
    : defaultParameters(interpolationType);

  return {
    startProgress: clamp(Number(segment.startProgress ?? 0), 0, 1),
    endProgress: clamp(Number(segment.endProgress ?? 1), 0, 1),
    interpolationType,
    reversed: segmentSupportsReverse(interpolationType)
      ? !!segment.reversed
      : false,
    parameters,
  };
}

export function normalizePiecewiseHeadingInterpolation(
  input?: PiecewiseHeadingInterpolation,
): PiecewiseHeadingInterpolation {
  const scope = input?.scope === "chain" ? "chain" : "path";
  const sourceSegments = input?.segments?.length
    ? input.segments
    : [createDefaultPiecewiseSegment()];

  const sorted = sourceSegments
    .map(normalizeSegment)
    .sort((left, right) => left.startProgress - right.startProgress);

  const repaired: PiecewiseHeadingSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < sorted.length; index += 1) {
    const source = sorted[index];
    const isLast = index === sorted.length - 1;
    const startProgress = index === 0 ? 0 : cursor;
    const desiredEnd = isLast
      ? 1
      : Math.max(source.endProgress, startProgress + MIN_SEGMENT_LENGTH);
    const endProgress = clamp(
      desiredEnd,
      startProgress + MIN_SEGMENT_LENGTH,
      1,
    );

    repaired.push({
      ...source,
      startProgress,
      endProgress,
    });

    cursor = endProgress;
  }

  if (repaired.length === 0) {
    return createDefaultPiecewiseHeadingInterpolation(scope);
  }

  const merged: PiecewiseHeadingSegment[] = [];
  for (const segment of repaired) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.endProgress === segment.startProgress &&
      previous.interpolationType === segment.interpolationType &&
      previous.reversed === segment.reversed &&
      areParametersEqual(previous.parameters, segment.parameters)
    ) {
      previous.endProgress = segment.endProgress;
      continue;
    }
    merged.push({
      ...segment,
      parameters: segment.parameters
        ? { ...segment.parameters, point: clonePoint(segment.parameters.point) }
        : undefined,
    });
  }

  merged[0].startProgress = 0;
  merged[merged.length - 1].endProgress = 1;

  return {
    scope,
    segments: merged,
  };
}

export function validatePiecewiseHeadingInterpolation(
  input?: PiecewiseHeadingInterpolation,
): string | null {
  const normalized = normalizePiecewiseHeadingInterpolation(input);

  if (!normalized.segments.length) {
    return "Piecewise heading requires at least one segment.";
  }

  if (normalized.segments[0].startProgress !== 0) {
    return "The first segment must start at 0.";
  }

  if (normalized.segments[normalized.segments.length - 1].endProgress !== 1) {
    return "The final segment must end at 1.";
  }

  for (let index = 0; index < normalized.segments.length; index += 1) {
    const segment = normalized.segments[index];
    if (segment.endProgress <= segment.startProgress) {
      return "Piecewise segments must have positive length.";
    }

    if (segment.interpolationType === "linear") {
      const params = segment.parameters || {};
      if (params.startDeg === undefined || params.endDeg === undefined) {
        return "Linear piecewise segments require start and end headings.";
      }
    }

    if (segment.interpolationType === "constant") {
      const params = segment.parameters || {};
      if (params.degrees === undefined) {
        return "Constant piecewise segments require a heading value.";
      }
    }

    if (segment.interpolationType === "facing-point") {
      const point = segment.parameters?.point;
      if (!point) {
        return "Facing-point segments require a target point.";
      }
    }

    const next = normalized.segments[index + 1];
    if (next && segment.endProgress !== next.startProgress) {
      return "Piecewise segments must not contain gaps or overlaps.";
    }
  }

  return null;
}

export function degreesToRadians(degrees: number): number {
  return (normalizeAngleDegrees(degrees) * Math.PI) / 180;
}

export function toDegreesDisplay(value: number): number {
  return normalizeAngleDegrees(value);
}

export function lineCurvePoints(
  startPoint: BasePoint,
  line: Line,
): BasePoint[] {
  return [startPoint, ...line.controlPoints, line.endPoint];
}

export function approximateCurveLength(
  points: BasePoint[],
  samples = 100,
): number {
  if (points.length < 2) return 0;

  let length = 0;
  let previousPoint = points[0];

  for (let index = 1; index <= samples; index += 1) {
    const t = index / samples;
    const point = getCurvePoint(t, points);
    const dx = point.x - previousPoint.x;
    const dy = point.y - previousPoint.y;
    length += Math.sqrt(dx * dx + dy * dy);
    previousPoint = point;
  }

  return length;
}

export function getPointAndTangentAtProgress(
  points: BasePoint[],
  progress: number,
  reversed = false,
): { point: BasePoint; tangentDegrees: number } {
  const clampedProgress = clamp(progress, 0, 1);
  const point = getCurvePoint(clampedProgress, points);
  const epsilon = 0.01;
  const nextT = clamp(clampedProgress + (reversed ? -epsilon : epsilon), 0, 1);
  const nextPoint = getCurvePoint(nextT, points);
  const dx = nextPoint.x - point.x;
  const dy = nextPoint.y - point.y;

  return {
    point,
    tangentDegrees:
      Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9
        ? 0
        : radiansToDegrees(Math.atan2(dy, dx)),
  };
}

export function getChainTraversalState(
  chain: PathChain,
  lines: Line[],
  startPoint: BasePoint,
  progress: number,
): { point: BasePoint; tangentDegrees: number } {
  const chainLines = chain.lineIds
    .map((lineId) => lines.find((line) => line.id === lineId))
    .filter((line): line is Line => Boolean(line));

  if (chainLines.length === 0) {
    return getPointAndTangentAtProgress([startPoint, startPoint], 0);
  }

  const lineData = chainLines.map((line, index) => {
    const lineStart = index === 0 ? startPoint : chainLines[index - 1].endPoint;
    const points = lineCurvePoints(lineStart, line);
    return {
      line,
      points,
      length: approximateCurveLength(points),
    };
  });

  const totalLength = lineData.reduce((sum, entry) => sum + entry.length, 0);
  if (totalLength <= 1e-9) {
    return getPointAndTangentAtProgress(lineData[0].points, 0);
  }

  const targetDistance = clamp(progress, 0, 1) * totalLength;
  let accumulated = 0;

  for (const entry of lineData) {
    const nextAccumulated = accumulated + entry.length;
    if (
      targetDistance <= nextAccumulated ||
      entry === lineData[lineData.length - 1]
    ) {
      const localProgress =
        entry.length <= 1e-9
          ? 0
          : (targetDistance - accumulated) / entry.length;
      return getPointAndTangentAtProgress(entry.points, localProgress);
    }
    accumulated = nextAccumulated;
  }

  return getPointAndTangentAtProgress(lineData[lineData.length - 1].points, 1);
}

export function evaluatePiecewiseHeading(
  interpolation: PiecewiseHeadingInterpolation,
  progress: number,
  options: {
    points: BasePoint[];
    currentPoint: BasePoint;
    tangentDegrees: number;
    chainState?: { point: BasePoint; tangentDegrees: number };
    pointOverride?: BasePoint;
  },
): number {
  const normalized = normalizePiecewiseHeadingInterpolation(interpolation);
  const segment =
    normalized.segments.find((entry, index) => {
      const isLast = index === normalized.segments.length - 1;
      return (
        progress >= entry.startProgress &&
        (progress <= entry.endProgress || isLast)
      );
    }) || normalized.segments[normalized.segments.length - 1];

  const localT = clamp(
    (progress - segment.startProgress) /
      Math.max(segment.endProgress - segment.startProgress, 1e-9),
    0,
    1,
  );

  const sourcePoint =
    interpolation.scope === "chain"
      ? options.chainState?.point || options.currentPoint
      : options.pointOverride || options.currentPoint;
  const sourceTangent =
    interpolation.scope === "chain"
      ? (options.chainState?.tangentDegrees ?? options.tangentDegrees)
      : options.tangentDegrees;

  switch (segment.interpolationType) {
    case "constant":
      return normalizeAngleDegrees(segment.parameters?.degrees ?? 0);
    case "linear":
      return interpolateAngleDegrees(
        segment.parameters?.startDeg ?? 0,
        segment.parameters?.endDeg ?? 0,
        localT,
        !!segment.reversed,
      );
    case "facing-point": {
      const point = segment.parameters?.point || { x: 0, y: 0 };
      const base = radiansToDegrees(
        Math.atan2(point.y - sourcePoint.y, point.x - sourcePoint.x),
      );
      return normalizeAngleDegrees(base + (segment.reversed ? 180 : 0));
    }
    case "tangential":
    default:
      return normalizeAngleDegrees(
        sourceTangent + (segment.reversed ? 180 : 0),
      );
  }
}
