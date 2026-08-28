import type { Line, Point, Settings, Shape } from "../../types";
import { FIELD_SIZE } from "../../config/defaults";

export const OPTIMIZER_BASE_URL = "https://fpa.pedropathing.com";

export function toHeadingDegrees(
  point: Point,
  position: "start" | "end",
): number {
  if (!point) return 0;
  if (point.heading === "linear") {
    return position === "start" ? (point.startDeg ?? 0) : (point.endDeg ?? 0);
  }
  if (point.heading === "constant") {
    return point.degrees ?? 0;
  }
  return 0;
}

export function buildOptimizationPayload(
  lineIndex: number,
  startPoint: Point,
  lines: Line[],
  shapes: Shape[],
  settings: Settings,
) {
  const line = lines[lineIndex];
  if (!line) throw new Error("Line not found");

  const startPt = lineIndex === 0 ? startPoint : lines[lineIndex - 1]?.endPoint;
  if (!startPt) throw new Error("Missing start point for optimization");

  const waypoints = [startPt, ...line.controlPoints, line.endPoint].map((p) => [
    p.x,
    p.y,
  ]);

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

export async function runOptimization(payload: any) {
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
    throw new Error(`Optimization failed: ${data.message || "Unknown error"}`);
  }
  throw new Error("Unexpected API response format");
}

/**
 * Fold an optimizer result back into the line list. Returns the updated lines,
 * or null when the response produced no applicable change.
 */
export function applyOptimizedWaypoints(
  lines: Line[],
  lineIndex: number,
  result: any,
  targetControlPointIndex?: number,
): Line[] | null {
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
    if (!replacement) return null;

    const cps = [...current.controlPoints];
    if (!cps[targetControlPointIndex]) return null;

    cps[targetControlPointIndex] = replacement;
    newLines[lineIndex] = { ...current, controlPoints: cps };
    return newLines;
  }

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
  return newLines;
}
