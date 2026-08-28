<script lang="ts">
  import type {
    Point,
    Line,
    BasePoint,
    Settings,
    Shape,
    SequenceItem,
  } from "../types";
  import _ from "lodash";
  import { getRandomColor } from "../utils";
  // Local normalizeLines helper (keeps behavior consistent with FileManager/App)
  function normalizeLines(input: Line[] = []): Line[] {
    return (input || []).map((line) => ({
      ...line,
      id: line.id || `line-${Math.random().toString(36).slice(2)}`,
      waitBeforeMs: Math.max(
        0,
        Number(line.waitBeforeMs ?? (line as any).waitBefore?.durationMs ?? 0),
      ),
      waitAfterMs: Math.max(
        0,
        Number(line.waitAfterMs ?? (line as any).waitAfter?.durationMs ?? 0),
      ),
      waitBeforeName: line.waitBeforeName ?? (line as any).waitBefore?.name ?? "",
      waitAfterName: line.waitAfterName ?? (line as any).waitAfter?.name ?? "",
    }));
  }
  import { snapToGrid, showGrid, gridSize } from "../stores";
  import ObstaclesSection from "./components/ObstaclesSection.svelte";
  import HeadingControls from "./components/HeadingControls.svelte";
  import RobotPositionDisplay from "./components/RobotPositionDisplay.svelte";
  import StartingPointSection from "./components/StartingPointSection.svelte";
  import PlaybackControls from "./components/PlaybackControls.svelte";
  import { calculatePathTime } from "../utils";
  import { curveThroughPoints } from "../utils/math";

  export let percent: number;
  export let playing: boolean;
  export let play: () => any;
  export let pause: () => any;
  export let startPoint: Point;
  export let lines: Line[];
  export let sequence: SequenceItem[];
  export let selectedLineIndex: number = 0;
  export let selectedPointIndex: number = 0;
  export let robotWidth: number = 16;
  export let robotHeight: number = 16;
  export let robotXY: BasePoint;
  export let robotHeading: number;
  export let x: d3.ScaleLinear<number, number>;
  export let y: d3.ScaleLinear<number, number>;
  export let settings: Settings;
  export let handleSeek: (percent: number) => void;
  export let loopAnimation: boolean;
  export let optimizeLine: (lineId: string, targetControlPointIndex?: number) => void;
  export let optimizingLineIds: Record<string, boolean> = {};

  export let shapes: Shape[];
  export let recordChange: () => void;

  let selectedLine: Line | null = null;
  let selectedLinePathIndex = -1;
  let selectedPoint: BasePoint | null = null;
  let selectedPointLabel = "Endpoint";
  let curveTension = 1.0;
  let obstaclesOpen = true;

  $: optimizeLine;
  $: optimizingLineIds;

  $: selectedLine = lines[selectedLineIndex] || lines[0] || null;
  $: selectedLinePathIndex = selectedLine ? lines.findIndex((line) => line.id === selectedLine.id) : -1;
  $: selectedPoint =
    selectedLine
      ? selectedPointIndex === 0
        ? selectedLine.endPoint
        : selectedLine.controlPoints[selectedPointIndex - 1] || null
      : null;
  $: if (selectedLine && selectedPointIndex > selectedLine.controlPoints.length) {
    selectedPointIndex = selectedLine.controlPoints.length;
  }
  $: if (selectedPointIndex < 0) {
    selectedPointIndex = 0;
  }
  $: selectedPointLabel =
    selectedLine && selectedPoint
      ? selectedPointIndex === 0
        ? "Endpoint"
        : `Control Point ${selectedPointIndex}`
      : "Selected Point";

  function commitSelectedPointChange() {
    lines = [...lines];
    recordChange?.();
  }

  function toggleSelectedPointLock() {
    if (!selectedPoint) return;
    selectedPoint.locked = !selectedPoint.locked;
    lines = [...lines];
    recordChange?.();
  }

  // Reference exported but unused props to silence Svelte unused-export warnings

  $: robotWidth;
  $: robotHeight;

  // Compute timeline markers for the UI (start of each travel segment)
  $: timePrediction = calculatePathTime(startPoint, lines, settings, sequence);
  $: markers = (() => {
    const _markers: { percent: number; color: string; name: string }[] = [];
    if (
      !timePrediction ||
      !timePrediction.timeline ||
      timePrediction.totalTime <= 0
    )
      return _markers;

    timePrediction.timeline.forEach((ev) => {
      if ((ev as any).type === "travel") {
        const end = (ev as any).endTime as number;
        const pct = (end / timePrediction.totalTime) * 100;
        const lineIndex = (ev as any).lineIndex as number;
        const line = lines[lineIndex];
        const color = line?.color || "#ffffff";
        const name = line?.name || `Path ${lineIndex + 1}`;
        _markers.push({ percent: pct, color, name });
      }
    });

    return _markers;
  })();


  // State for collapsed sections
  let collapsedSections = {
    obstacles: shapes.map(() => true),
    lines: lines.map(() => false),
    controlPoints: lines.map(() => true), // Start with control points collapsed
  };

  // Collapsed state for obstacles (default collapsed)
  let collapsedObstacles = shapes.map(() => true);

  // Reactive statements to update UI state when lines or shapes change from file load
  $: if (lines.length !== collapsedSections.lines.length) {
    collapsedSections = {
      obstacles: collapsedSections.obstacles ?? shapes.map(() => true),
      lines: lines.map(() => false),
      controlPoints: lines.map(() => true),
    };
  }

  // Keep obstacle collapse state aligned with shapes list
  $: if (shapes.length !== collapsedObstacles.length) {
    collapsedObstacles = shapes.map(() => true);
  }

  $: if (!collapsedSections.obstacles || shapes.length !== collapsedSections.obstacles.length) {
    collapsedSections = {
      ...collapsedSections,
      obstacles: shapes.map(() => true),
    };
  }

  const makeId = () =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  function getWait(i: any) {
    return i as any;
  }

  function insertLineAfter(seqIndex: number) {
    const seqItem = sequence[seqIndex];
    if (!seqItem || seqItem.kind !== "path") return;
    const lineIndex = lines.findIndex((l) => l.id === seqItem.lineId);
    const currentLine = lines[lineIndex];

    // Find the next path item in the sequence after seqIndex
    let nextPathSeqIndex = -1;
    for (let i = seqIndex + 1; i < sequence.length; i++) {
      if (sequence[i].kind === "path") {
        nextPathSeqIndex = i;
        break;
      }
    }

    // If there is no next path in sequence, fall back to addLine behavior (append new randomized point)
    let newPoint: Point | null = null;
    if (nextPathSeqIndex !== -1) {
      const nextLineId = (sequence[nextPathSeqIndex] as any).lineId;
      const nextLine = lines.find((l) => l.id === nextLineId);
      if (
        nextLine &&
        nextLine.endPoint &&
        currentLine &&
        currentLine.endPoint
      ) {
        const a = currentLine.endPoint;
        const b = nextLine.endPoint;
        const midX = (Number(a.x) + Number(b.x)) / 2;
        const midY = (Number(a.y) + Number(b.y)) / 2;
        newPoint = {
          x: midX,
          y: midY,
          heading: "tangential",
          reverse: false,
        };
      }
    }

    if (!newPoint) {
      // fallback: random nearby point from current end
      if (currentLine && currentLine.endPoint) {
        newPoint = {
          x: (currentLine.endPoint.x ?? 72) + _.random(-12, 12),
          y: (currentLine.endPoint.y ?? 72) + _.random(-12, 12),
          heading: "tangential",
          reverse: false,
        };
      } else {
        newPoint = {
          x: _.random(0, 141.5),
          y: _.random(0, 141.5),
          heading: "tangential",
          reverse: false,
        };
      }
    }

    const newLine = {
      id: makeId(),
      endPoint: newPoint,
      controlPoints: [],
      color: getRandomColor(),
      name: `Path ${lines.length + 1}`,
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };

    // Insert the new line after the current one and a sequence item after current seq index
    const newLines = [...lines];
    newLines.splice(lineIndex + 1, 0, newLine);
    lines = newLines;

    const newSeq = [...sequence];
    newSeq.splice(seqIndex + 1, 0, { kind: "path", lineId: newLine.id! });
    sequence = newSeq;

    collapsedSections.lines.splice(lineIndex + 1, 0, false);
    collapsedSections.controlPoints.splice(lineIndex + 1, 0, true);

    // Force reactivity
    collapsedSections = { ...collapsedSections };
  }

  // Insert a midpoint between this path and the next path in sequence
  function insertMidpointAfter(seqIndex: number) {
    const seqItem = sequence[seqIndex];
    if (!seqItem || seqItem.kind !== "path") return;
    const lineIndex = lines.findIndex((l) => l.id === seqItem.lineId);
    const currentLine = lines[lineIndex];

    // Find the next path in sequence
    let nextPathSeqIndex = -1;
    for (let i = seqIndex + 1; i < sequence.length; i++) {
      if (sequence[i].kind === "path") {
        nextPathSeqIndex = i;
        break;
      }
    }

    if (nextPathSeqIndex === -1) {
      // no next path -> do nothing or fallback
      return;
    }

    const nextLineId = (sequence[nextPathSeqIndex] as any).lineId;
    const nextLine = lines.find((l) => l.id === nextLineId);
    if (!currentLine || !nextLine) return;

    const a = currentLine.endPoint;
    const b = nextLine.endPoint;
    const midX = (Number(a.x) + Number(b.x)) / 2;
    const midY = (Number(a.y) + Number(b.y)) / 2;

    const newLine: Line = {
      id: makeId(),
      endPoint: {
        x: midX,
        y: midY,
        heading: "tangential",
        reverse: false,
      },
      controlPoints: [],
      color: getRandomColor(),
      name: `Path ${lines.length + 1}`,
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };

    // Insert into lines right after current line index
    const newLines = [...lines];
    newLines.splice(lineIndex + 1, 0, newLine);
    lines = newLines;

    // Insert into sequence right after seqIndex
    const newSeq = [...sequence];
    newSeq.splice(seqIndex + 1, 0, { kind: "path", lineId: newLine.id! });
    sequence = newSeq;

    collapsedSections.lines.splice(lineIndex + 1, 0, false);
    collapsedSections.controlPoints.splice(lineIndex + 1, 0, true);

    collapsedSections = { ...collapsedSections };
    recordChange();
  }

  function createPathBetweenSelectedPoints() {
    if (!selectedLine?.id) return;
    const seqIndex = sequence.findIndex(
      (item) => item.kind === "path" && item.lineId === selectedLine.id,
    );
    if (seqIndex === -1) return;
    insertMidpointAfter(seqIndex);
  }

  // Convert selected line to cubic Bezier curve using a Catmull-Rom through-points approach.
  // This replaces controlPoints with two control points (cubic) computed from adjacent points.
  function curveFromSelected(tension = 1.0) {
    if (!selectedLine || selectedLineIndex == null) return;

    // Find the index of this line in the sequence
    const seqIndex = sequence.findIndex((item) => item.kind === "path" && item.lineId === selectedLine.id);
    if (seqIndex === -1) return;

    // Get previous point (startPoint for first line, or previous line's endPoint)
    const prevPoint = selectedLineIndex > 0 ? lines[selectedLineIndex - 1].endPoint : startPoint;
    const startPt = selectedLine.endPoint;

    // Find next line in sequence
    let nextLineId: string | null = null;
    for (let i = seqIndex + 1; i < sequence.length; i++) {
      if (sequence[i].kind === "path") {
        nextLineId = (sequence[i] as any).lineId;
        break;
      }
    }

    const nextLine = nextLineId ? lines.find((l) => l.id === nextLineId) : null;
    const endPt = nextLine?.endPoint || startPt;

    // Build poses: prevPoint -> startPt -> endPt
    const poses = [prevPoint, startPt, endPt];

    const segments = curveThroughPoints(tension, poses);
    if (!segments || segments.length === 0) {
      alert("Curve generation produced no segments — need at least two path points.");
      return;
    }

    const nextLines = [...lines];
    const seg = segments[0];
    const existing = nextLines[selectedLineIndex];
    if (existing) {
      nextLines[selectedLineIndex] = {
        ...existing,
        controlPoints: [ { x: seg.cp1.x, y: seg.cp1.y }, { x: seg.cp2.x, y: seg.cp2.y } ],
        endPoint: { ...existing.endPoint, x: seg.end.x, y: seg.end.y },
      };
    }

    lines = normalizeLines(nextLines);
    recordChange();
    alert(`Curved path with tension ${tension}`);
  }

  function removeLine(idx: number) {
    const removedId = lines[idx]?.id;
    let _lns = lines;
    lines.splice(idx, 1);
    lines = _lns;
    if (removedId) {
      sequence = sequence.filter(
        (s) => s.kind === "wait" || s.lineId !== removedId,
      );
    }
    collapsedSections.lines.splice(idx, 1);
    collapsedSections.controlPoints.splice(idx, 1);
    recordChange();
  }

  function deleteSelectedLine() {
    if (!selectedLine) return;
    if (lines.length <= 1) return;

    removeLine(selectedLineIndex);
    selectedLineIndex = Math.max(0, Math.min(selectedLineIndex, lines.length - 1));
    selectedPointIndex = 0;
    recordChange();
  }

  function deleteSelectedControlPoint() {
    if (!selectedLine || selectedPointIndex <= 0) return;

    const controlPointIndex = selectedPointIndex - 1;
    if (!selectedLine.controlPoints[controlPointIndex]) return;

    selectedLine.controlPoints.splice(controlPointIndex, 1);
    lines = [...lines];
    selectedPointIndex = Math.min(selectedPointIndex, selectedLine.controlPoints.length);
    recordChange();
  }

  function addLine() {
    const newLine: Line = {
      id: makeId(),
      name: `Path ${lines.length + 1}`,
      endPoint: {
        x: _.random(0, 141.5),
        y: _.random(0, 141.5),
        heading: "tangential",
        reverse: false,
      },
      controlPoints: [],
      color: getRandomColor(),
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };
    lines = [...lines, newLine];
    sequence = [...sequence, { kind: "path", lineId: newLine.id! }];
    collapsedSections.lines.push(false);
    collapsedSections.controlPoints.push(true);
    recordChange();
  }

  // Add a control point to the line represented by `seqIndex` in the sequence
  function addControlPointToLine(seqIndex: number) {
    const seqItem = sequence[seqIndex];
    if (!seqItem || seqItem.kind !== "path") return;
    const lineIndex = lines.findIndex((l) => l.id === seqItem.lineId);
    if (lineIndex === -1) return;
    const line = lines[lineIndex];
    line.controlPoints = line.controlPoints || [];
    const prevPt = lineIndex === 0 ? startPoint : lines[lineIndex - 1].endPoint;
    const endPt = line.endPoint || { x: 72, y: 72 };
    const mx = ((prevPt?.x ?? 72) + (endPt?.x ?? 72)) / 2;
    const my = ((prevPt?.y ?? 72) + (endPt?.y ?? 72)) / 2;
    line.controlPoints.push({
      x: mx + _.random(-4, 4),
      y: my + _.random(-4, 4),
    });
    collapsedSections.controlPoints[lineIndex] = false;
    lines = [...lines];
    collapsedSections = { ...collapsedSections };
    recordChange?.();
  }

  // Add a control point to the last path in `lines` (fallback: create a new line)
  function addControlPointToLastLine() {
    if (!lines || lines.length === 0) {
      // No lines exist: create a new line instead
      addLine();
      return;
    }

    // Prefer adding to the first line whose control points are expanded (user is focusing it)
    let targetIdx = collapsedSections.controlPoints.findIndex(
      (v) => v === false,
    );
    if (targetIdx === -1) targetIdx = lines.length - 1;

    const line = lines[targetIdx];
    line.controlPoints = line.controlPoints || [];
    // Insert a control point near the line midpoint for convenience
    const prevPt = targetIdx === 0 ? startPoint : lines[targetIdx - 1].endPoint;
    const endPt = line.endPoint || { x: 72, y: 72 };
    const mx = ((prevPt?.x ?? 72) + (endPt?.x ?? 72)) / 2;
    const my = ((prevPt?.y ?? 72) + (endPt?.y ?? 72)) / 2;
    line.controlPoints.push({
      x: mx + _.random(-4, 4),
      y: my + _.random(-4, 4),
    });
    // Ensure control points UI is expanded for this line
    collapsedSections.controlPoints[targetIdx] = false;
    lines = [...lines];
    collapsedSections = { ...collapsedSections };
    recordChange?.();
  }

  function addWait() {
    const wait = {
      kind: "wait",
      id: makeId(),
      name: "Wait",
      durationMs: 0,
      locked: false,
    } as SequenceItem;
    sequence = [...sequence, wait];
  }

  function addWaitAtStart() {
    const wait = {
      kind: "wait",
      id: makeId(),
      name: "Wait",
      durationMs: 0,
      locked: false,
    } as SequenceItem;
    sequence = [wait, ...sequence];
  }

  function addPathAtStart() {
    const newLine: Line = {
      id: makeId(),
      name: `Path ${lines.length + 1}`,
      endPoint: {
        x: _.random(0, 141.5),
        y: _.random(0, 141.5),
        heading: "tangential",
        reverse: false,
      },
      controlPoints: [],
      color: getRandomColor(),
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };
    lines = [newLine, ...lines];
    sequence = [{ kind: "path", lineId: newLine.id! }, ...sequence];
    collapsedSections.lines = [false, ...collapsedSections.lines];
    collapsedSections.controlPoints = [
      true,
      ...collapsedSections.controlPoints,
    ];
    recordChange();
  }

  function insertWaitAfter(seqIndex: number) {
    const newSeq = [...sequence];
    newSeq.splice(seqIndex + 1, 0, {
      kind: "wait",
      id: makeId(),
      name: "Wait",
      durationMs: 0,
      locked: false,
    });
    sequence = newSeq;
  }

  function insertPathAfter(seqIndex: number) {
    // Create a new line with default settings
    const newLine: Line = {
      id: makeId(),
      name: `Path ${lines.length + 1}`,
      endPoint: {
        x: _.random(36, 108),
        y: _.random(36, 108),
        heading: "tangential",
        reverse: false,
      },
      controlPoints: [],
      color: getRandomColor(),
      waitBeforeMs: 0,
      waitAfterMs: 0,
      waitBeforeName: "",
      waitAfterName: "",
    };

    // Add the new line to the lines array
    lines = [...lines, newLine];

    // Insert the new path in the sequence after the wait
    const newSeq = [...sequence];
    newSeq.splice(seqIndex + 1, 0, { kind: "path", lineId: newLine.id! });
    sequence = newSeq;

    // Add UI state for the new line
    collapsedSections.lines.push(false);
    collapsedSections.controlPoints.push(true);

    // Force reactivity
    collapsedSections = { ...collapsedSections };
    recordChange();
  }

  function syncLinesToSequence(newSeq: SequenceItem[]) {
    const pathOrder = newSeq
      .filter((item) => item.kind === "path")
      .map((item) => item.lineId);

    const indexedLines = lines.map((line, idx) => ({
      line,
      collapsed: collapsedSections.lines[idx],
      control: collapsedSections.controlPoints[idx],
    }));

    const byId = new Map(indexedLines.map((entry) => [entry.line.id, entry]));
    const reordered: typeof indexedLines = [];

    pathOrder.forEach((id) => {
      const entry = byId.get(id);
      if (entry) {
        reordered.push(entry);
        byId.delete(id);
      }
    });

    // Append any lines that are not currently in the sequence to preserve data
    reordered.push(...byId.values());

    lines = reordered.map((entry) => entry.line);
    collapsedSections = {
      ...collapsedSections,
      lines: reordered.map((entry) => entry.collapsed ?? false),
      controlPoints: reordered.map((entry) => entry.control ?? true),
    };
    // No collapsedEventMarkers to update
  }

  function moveSequenceItem(seqIndex: number, delta: number) {
    const targetIndex = seqIndex + delta;
    if (targetIndex < 0 || targetIndex >= sequence.length) return;

    // Prevent moving if either the source or target is a locked path or a locked wait
    const isLockedSequenceItem = (index: number) => {
      const it = sequence[index];
      if (!it) return false;
      if (it.kind === "path") {
        const ln = lines.find((l) => l.id === it.lineId);
        return ln?.locked ?? false;
      }
      // wait
      if (it.kind === "wait") {
        return (it as any).locked ?? false;
      }
      return false;
    };

    if (isLockedSequenceItem(seqIndex) || isLockedSequenceItem(targetIndex))
      return;

    const newSeq = [...sequence];
    const [item] = newSeq.splice(seqIndex, 1);
    newSeq.splice(targetIndex, 0, item);
    sequence = newSeq;

    syncLinesToSequence(newSeq);
    recordChange?.();
  }
</script>

<div class="flex-1 flex flex-col justify-start items-center gap-2 h-full">
  <div
    class="flex flex-col justify-start items-start w-full bg-[#1a1a1a] border border-[#333333] p-3 overflow-y-scroll overflow-x-hidden h-full gap-3"
  >
    <div class="w-full flex flex-col gap-2">
      {#if settings.experimentalFeatures?.obstacles}
        <button
          class="flex items-center justify-between gap-2 w-full border border-[#333333] bg-[#222222] px-3 py-2 text-xs text-gray-200"
          on:click={() => (obstaclesOpen = !obstaclesOpen)}
          title={obstaclesOpen ? "Hide obstacle editor" : "Show obstacle editor"}
        >
          <span class="font-semibold uppercase tracking-wide">Obstacles</span>
          <span class="text-[11px] text-gray-400">{obstaclesOpen ? "Hide" : "Show"}</span>
        </button>
        {#if obstaclesOpen}
          <ObstaclesSection bind:shapes bind:collapsedObstacles />
        {/if}
      {/if}
    </div>

    <div class="grid w-full grid-cols-1 gap-2 lg:grid-cols-2">
      <div class="w-full border border-[#333333] bg-[#222222] p-3">
        <StartingPointSection bind:startPoint />
      </div>
      <div class="w-full border border-[#333333] bg-[#222222] p-3">
        <RobotPositionDisplay {robotXY} {robotHeading} {x} {y} />
      </div>
    </div>

    <div class="w-full border border-[#333333] bg-[#222222] p-3 text-xs text-gray-400 space-y-3">
      <div class="flex items-start justify-between gap-3 border-b border-[#333333] pb-2">
        <div>
          <div class="font-semibold text-gray-100">Selected Path</div>
          <div class="text-[11px] text-gray-500">Pick a path in the list to inspect it.</div>
        </div>
        <div class="flex items-center gap-2">
          <div class="text-[11px] text-gray-400">{selectedLine ? `#${selectedLinePathIndex + 1}` : "None"}</div>
          {#if settings.experimentalFeatures?.curveThrough && selectedLine}
            <input
              type="number"
              min="0.1"
              max="3"
              step="0.1"
              bind:value={curveTension}
              class="w-20 px-2 py-1 rounded border bg-[#111111] text-sm text-gray-200"
              title="Curve tension (smaller = looser)"
            />
            <button
              class="rounded border border-[#444444] bg-[#2b2b2b] px-2 py-1 text-[10px] font-semibold text-gray-200 hover:bg-[#333333] disabled:cursor-not-allowed disabled:opacity-50"
              on:click={() => curveFromSelected(curveTension)}
              disabled={selectedLine.controlPoints.length === 0}
              title="Convert this path to a smooth cubic Bezier"
            >
              Curve Path
            </button>
          {/if}
          <button
            class="rounded border border-red-700 bg-red-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-2"
            on:click={deleteSelectedLine}
            disabled={!selectedLine || lines.length <= 1}
            title={lines.length <= 1 ? "At least one path must remain" : "Delete the selected path"}
          >
            <span class="font-bold">✕</span>
            <span>Delete Path</span>
          </button>
        </div>
      </div>

    {#if selectedLine}
      <div class="grid grid-cols-2 gap-2 text-[11px] text-gray-300">
        <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
          <div class="text-gray-500">Name</div>
          <input
            value={selectedLine.name || ""}
            placeholder={`Path ${selectedLinePathIndex + 1}`}
            type="text"
            class="w-full bg-transparent font-medium text-gray-100 border-none outline-none focus:ring-1 focus:ring-green-500 rounded px-0 py-0.5"
            disabled={selectedLine.locked}
            on:input={(e) => {
              selectedLine.name = e.currentTarget.value;
              lines = [...lines];
            }}
            on:change={() => recordChange?.()}
          />
        </div>
          <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
            <div class="text-gray-500">Endpoint</div>
            <div class="font-medium text-gray-100">{selectedLine.endPoint.x.toFixed(1)}, {selectedLine.endPoint.y.toFixed(1)}</div>
          </div>
          <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
            <div class="text-gray-500">Control Points</div>
            <div class="font-medium text-gray-100">{selectedLine.controlPoints.length}</div>
          </div>
          <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
            <div class="text-gray-500">Locked</div>
            <div class="font-medium text-gray-100">{selectedLine.locked ? "Yes" : "No"}</div>
          </div>
        </div>

        <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-2 leading-tight">
          <div class="flex items-center justify-between gap-2">
            <div>
              <div class="text-gray-500">Selected Point</div>
              <div class="font-medium text-gray-100">{selectedPointLabel}</div>
            </div>
            <div class="flex flex-wrap gap-1">
              <button
                class={`rounded border border-[#444444] px-2 py-1 text-[10px] font-semibold text-gray-200 hover:bg-[#2a2a2a] ${selectedPointIndex === 0 ? "bg-[#2f2f2f]" : ""}`}
                on:click={() => (selectedPointIndex = 0)}
              >
                Endpoint
              </button>
              {#each selectedLine.controlPoints as _, pointIdx}
                <button
                  class={`rounded border border-[#444444] px-2 py-1 text-[10px] font-semibold text-gray-200 hover:bg-[#2a2a2a] ${selectedPointIndex === pointIdx + 1 ? "bg-[#2f2f2f]" : ""}`}
                  on:click={() => (selectedPointIndex = pointIdx + 1)}
                >
                  CP{pointIdx + 1}
                </button>
              {/each}
            </div>
          </div>

          {#if selectedPoint}
            {#if selectedPointIndex === 0}
              <div class="mt-3 flex flex-col gap-1 text-[11px]">
                <span class="text-gray-500">Name</span>
                <input
                  value={selectedLine.name || ""}
                  placeholder={`Path ${selectedLinePathIndex + 1}`}
                  type="text"
                  class="w-full rounded border border-[#444444] bg-[#111111] px-2 py-1 text-gray-100 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={selectedLine.locked || !!selectedPoint.locked}
                  on:input={(e) => {
                    selectedLine.name = e.currentTarget.value;
                    lines = [...lines];
                  }}
                  on:change={() => recordChange?.()}
                />
              </div>
            {/if}

            <div class="mt-3 flex flex-wrap items-end gap-2 text-[11px]">
              <label class="flex flex-col gap-1">
                <span class="text-gray-500">X</span>
                <input
                  bind:value={selectedPoint.x}
                  type="number"
                  min="0"
                  max="141.5"
                  step={$snapToGrid && $showGrid ? $gridSize : 0.1}
                  class="w-24 rounded border border-[#444444] bg-[#111111] px-2 py-1 text-gray-100 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                  on:change={commitSelectedPointChange}
                  disabled={selectedLine.locked || !!selectedPoint.locked}
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-gray-500">Y</span>
                <input
                  bind:value={selectedPoint.y}
                  type="number"
                  min="0"
                  max="141.5"
                  step={$snapToGrid && $showGrid ? $gridSize : 0.1}
                  class="w-24 rounded border border-[#444444] bg-[#111111] px-2 py-1 text-gray-100 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                  on:change={commitSelectedPointChange}
                  disabled={selectedLine.locked || !!selectedPoint.locked}
                />
              </label>
            </div>

            {#if selectedPointIndex === 0}
              <div class="mt-3 flex items-center gap-2 text-[11px] text-gray-300 flex-wrap">
                <div class="text-gray-500">Heading</div>
                <HeadingControls
                  endPoint={selectedLine.endPoint}
                  locked={selectedLine.locked || !!selectedPoint.locked}
                  on:change={() => {
                    lines = [...lines];
                  }}
                  on:commit={() => {
                    lines = [...lines];
                    recordChange?.();
                  }}
                />
              </div>
            {/if}

            <div class="mt-2 flex items-center justify-between gap-2 text-[11px] text-gray-300">
              <div>
                Locked: <span class="font-medium text-gray-100">{selectedPoint.locked ? "Yes" : "No"}</span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  class="rounded border border-[#444444] px-2 py-1 font-semibold text-gray-100 hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-50"
                  on:click={deleteSelectedControlPoint}
                  disabled={selectedLine.locked || selectedPointIndex === 0 || selectedLine.controlPoints.length === 0}
                  title={selectedPointIndex === 0 ? "Endpoint cannot be deleted" : "Delete the selected control point"}
                >
                  Delete Control Point
                </button>
                <button
                  class="rounded border border-[#444444] px-2 py-1 font-semibold text-gray-100 hover:bg-[#2a2a2a] disabled:cursor-not-allowed disabled:opacity-50"
                  on:click={toggleSelectedPointLock}
                  disabled={selectedLine.locked}
                >
                  {selectedPoint.locked ? "Unlock Point" : "Lock Point"}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <div class="grid gap-2 text-[11px] sm:grid-cols-2">
          <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-2 leading-tight">
            <div class="text-gray-500">Color</div>
            <div class="mt-1 flex items-center gap-2 font-medium text-gray-100 leading-snug">
              <span class="size-2.5 rounded-full" style={`background:${selectedLine?.color || "#666666"}`}></span>
              <span>{selectedLine?.color || "Default"}</span>
            </div>
          </div>

          <div class="border border-[#333333] bg-[#1f1f1f] px-2 py-2 leading-tight">
            <div class="text-gray-500">Status</div>
            <div class="mt-1 font-medium text-gray-100 leading-snug">
              {selectedLine?.locked ? "Locked" : "Editable"}
            </div>
          </div>
        </div>
      {:else}
        <div class="text-[11px] text-gray-500">Select a path from the left list to inspect it here.</div>
      {/if}
    </div>
  </div>

  <PlaybackControls
    bind:playing
    {play}
    {pause}
    bind:percent
    {handleSeek}
    bind:loopAnimation
    {markers}
    totalTime={timePrediction?.totalTime ?? 0}
  />
</div>