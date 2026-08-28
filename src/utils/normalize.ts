import type { Line, SequenceItem } from "../types";
import { getRandomColor } from "./color";

export function makeLineId(): string {
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A new path segment ending at (x, y), with defaults matching normalizeLines. */
export function createLine(
  x: number,
  y: number,
  options: { reverse?: boolean } = {},
): Line {
  return {
    id: makeLineId(),
    endPoint: {
      x,
      y,
      heading: "tangential",
      reverse: options.reverse ?? false,
    },
    controlPoints: [],
    color: getRandomColor(),
    locked: false,
    waitBeforeMs: 0,
    waitAfterMs: 0,
    waitBeforeName: "",
    waitAfterName: "",
  };
}

export function normalizeLines(input: Line[] = []): Line[] {
  return (input || []).map((line) => ({
    ...line,
    id: line.id || makeLineId(),
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

export function deriveSequence(
  data: any,
  normalizedLines: Line[],
): SequenceItem[] {
  if (Array.isArray(data?.sequence) && data.sequence.length) {
    return data.sequence as SequenceItem[];
  }

  return normalizedLines.map((ln) => ({
    kind: "path",
    lineId: ln.id!,
  }));
}
