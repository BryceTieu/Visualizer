import Two from "two.js";
import type { BasePoint, Line, Shape } from "../../types";
import { POINT_RADIUS } from "../../config/defaults";
import type { SceneScales } from "./types";

const LABEL_FAMILY = "ui-sans-serif, system-ui, sans-serif";
const SELECTED_LINE_STROKE = "#facc15";
const SELECTED_POINT_STROKE = "#f59e0b";

export interface PointSelection {
  lineIndex: number;
  pointIndex: number;
}

export interface PointMarkerOptions {
  idPrefix: string;
  color?: string;
  radiusScale?: number;
  textSize?: number;
  opacity?: number;
  selection?: PointSelection | null;
}

function circle(
  point: BasePoint,
  radius: number,
  { x, y }: SceneScales,
): InstanceType<typeof Two.Circle> {
  return new Two.Circle(x(point.x), y(point.y), x(radius));
}

function label(
  point: BasePoint,
  text: string,
  size: number,
  { x, y }: SceneScales,
): InstanceType<typeof Two.Text> {
  const pointText = new Two.Text(text, x(point.x), y(point.y - 0.15));
  pointText.size = x(size);
  pointText.leading = 1;
  pointText.family = LABEL_FAMILY;
  pointText.alignment = "center";
  pointText.baseline = "middle";
  pointText.fill = "white";
  pointText.noStroke();
  return pointText;
}

function highlightRing(
  point: BasePoint,
  id: string,
  radius: number,
  isSelectedPoint: boolean,
  scales: SceneScales,
) {
  const ring = circle(point, radius * 1.45, scales);
  ring.id = id;
  ring.fill = "transparent";
  ring.stroke = isSelectedPoint ? SELECTED_POINT_STROKE : SELECTED_LINE_STROKE;
  ring.linewidth = scales.x(isSelectedPoint ? 0.45 : 0.25);
  return ring;
}

/**
 * Point markers for one path: a start dot, then an end dot plus numbered
 * control-point markers per line. Passing `selection` turns on the selected
 * line/point styling used by the main path; second and additional paths omit it.
 */
export function buildPathPointMarkers(
  startPoint: BasePoint,
  lines: Line[],
  scales: SceneScales,
  options: PointMarkerOptions,
): any[] {
  const {
    idPrefix,
    color,
    radiusScale = 1,
    textSize = 1.55,
    opacity,
    selection = null,
  } = options;

  const radius = POINT_RADIUS * radiusScale;
  const elements: any[] = [];

  const startElem = circle(startPoint, radius, scales);
  startElem.id = `${idPrefix}-0-0`;
  startElem.fill = color || lines[0]?.color || "#888";
  startElem.noStroke();
  if (opacity !== undefined) startElem.opacity = opacity;
  elements.push(startElem);

  lines.forEach((line, idx) => {
    if (!line || !line.endPoint) return;
    const isSelectedLine = selection?.lineIndex === idx;

    [line.endPoint, ...line.controlPoints].forEach((point, idx1) => {
      const baseId = `${idPrefix}-${idx + 1}-${idx1}`;
      const fill = color || line.color;

      if (idx1 > 0) {
        const group = new Two.Group();
        group.id = baseId;

        const pointElem = circle(point, radius, scales);
        pointElem.id = `${baseId}-background`;
        pointElem.fill = fill;
        if (selection) {
          pointElem.stroke = isSelectedLine ? SELECTED_LINE_STROKE : line.color;
          pointElem.linewidth = scales.x(isSelectedLine ? 0.7 : 0.25);
        } else {
          pointElem.noStroke();
        }

        if (isSelectedLine) {
          group.add(
            highlightRing(
              point,
              `${baseId}-highlight`,
              radius,
              selection?.pointIndex === idx1,
              scales,
            ),
          );
        }

        const pointText = label(point, `${idx1}`, textSize, scales);
        pointText.id = `${baseId}-text`;

        group.add(pointElem, pointText);
        if (opacity !== undefined) group.opacity = opacity;
        elements.push(group);
      } else {
        const pointElem = circle(point, radius, scales);
        pointElem.id = baseId;
        pointElem.fill = fill;
        if (selection) {
          pointElem.stroke = isSelectedLine ? SELECTED_LINE_STROKE : line.color;
          pointElem.linewidth = scales.x(isSelectedLine ? 0.7 : 0.25);
        } else {
          pointElem.noStroke();
        }
        if (opacity !== undefined) pointElem.opacity = opacity;

        if (isSelectedLine) {
          elements.push(
            highlightRing(
              point,
              `${baseId}-highlight`,
              radius,
              selection?.pointIndex === idx1,
              scales,
            ),
          );
        }
        elements.push(pointElem);
      }
    });
  });

  return elements;
}

export function buildSelectedPointRing(
  lines: Line[],
  selection: PointSelection,
  scales: SceneScales,
): any[] {
  const selectedLine = lines[selection.lineIndex];
  const selectedPoint =
    selectedLine && selection.pointIndex >= 0
      ? selection.pointIndex === 0
        ? selectedLine.endPoint
        : selectedLine.controlPoints[selection.pointIndex - 1]
      : null;

  if (!selectedLine || !selectedPoint) return [];

  const ring = circle(selectedPoint, POINT_RADIUS * 1.7, scales);
  ring.id = `selected-point-${selection.lineIndex}-${selection.pointIndex}`;
  ring.fill = "transparent";
  ring.stroke = SELECTED_LINE_STROKE;
  ring.linewidth = scales.x(0.35);
  ring.opacity = 0.95;
  return [ring];
}

/** Draggable vertex handles for obstacle polygons. */
export function buildObstacleVertexMarkers(
  shapes: Shape[],
  scales: SceneScales,
): any[] {
  return shapes.flatMap((shape, shapeIdx) =>
    shape.vertices.map((vertex, vertexIdx) => {
      const id = `obstacle-${shapeIdx}-${vertexIdx}`;
      const group = new Two.Group();
      group.id = id;

      const pointElem = circle(vertex, POINT_RADIUS, scales);
      pointElem.id = `${id}-background`;
      pointElem.fill = shape.fillColor;
      pointElem.noStroke();

      const pointText = label(vertex, `${vertexIdx + 1}`, 1.55, scales);
      pointText.id = `${id}-text`;

      group.add(pointElem, pointText);
      return group;
    }),
  );
}
