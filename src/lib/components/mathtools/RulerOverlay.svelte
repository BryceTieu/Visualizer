<script lang="ts">
  import { FIELD_SIZE } from "../../../config";
  import { clamp } from "../../../utils/math";
  import type * as d3 from "d3";

  export let x: d3.ScaleLinear<number, number>;
  export let y: d3.ScaleLinear<number, number>;
  export let twoElement: HTMLDivElement;

  let rulerStart = { x: 20, y: 72 };
  let rulerEnd = { x: 80, y: 72 };
  let dragging: "start" | "end" | null = null;

  $: rulerLength = Math.hypot(
    rulerEnd.x - rulerStart.x,
    rulerEnd.y - rulerStart.y,
  );

  function handleMouseDown(event: MouseEvent, which: "start" | "end") {
    event.stopPropagation();
    dragging = which;
  }

  function handleMouseMove(event: MouseEvent) {
    if (!dragging || !twoElement) return;

    const rect = twoElement.getBoundingClientRect();
    const point = {
      x: clamp(x.invert(event.clientX - rect.left), 0, FIELD_SIZE),
      y: clamp(y.invert(event.clientY - rect.top), 0, FIELD_SIZE),
    };

    if (dragging === "start") rulerStart = point;
    else rulerEnd = point;
  }

  function handleMouseUp() {
    dragging = null;
  }
</script>

<svelte:window on:mousemove={handleMouseMove} on:mouseup={handleMouseUp} />

<svg class="absolute top-0 left-0 w-full h-full z-40 pointer-events-none">
  <!-- Ruler line -->
  <line
    x1={x(rulerStart.x)}
    y1={y(rulerStart.y)}
    x2={x(rulerEnd.x)}
    y2={y(rulerEnd.y)}
    stroke="#3b82f6"
    stroke-width="3"
    class="pointer-events-none"
  />

  <!-- Start handle -->
  <circle
    cx={x(rulerStart.x)}
    cy={y(rulerStart.y)}
    r="8"
    fill="#3b82f6"
    class="cursor-move pointer-events-auto"
    role="button"
    tabindex="0"
    aria-label="Ruler start point"
    on:mousedown={(e) => handleMouseDown(e, "start")}
  />

  <!-- End handle -->
  <circle
    cx={x(rulerEnd.x)}
    cy={y(rulerEnd.y)}
    r="8"
    fill="#3b82f6"
    class="cursor-move pointer-events-auto"
    role="button"
    tabindex="0"
    aria-label="Ruler end point"
    on:mousedown={(e) => handleMouseDown(e, "end")}
  />

  <!-- Length label -->
  <text
    x={(x(rulerStart.x) + x(rulerEnd.x)) / 2}
    y={(y(rulerStart.y) + y(rulerEnd.y)) / 2 - 10}
    class="fill-blue-600 dark:fill-blue-400 font-semibold pointer-events-none"
    text-anchor="middle"
  >
    {rulerLength.toFixed(2)}"
  </text>
</svg>
