<script lang="ts">
  import type { BasePoint, Settings } from "../../types";

  export let xy: BasePoint;
  export let heading: number;
  export let widthPx: number;
  export let heightPx: number;
  export let settings: Settings;
  export let alt = "Robot";
  export let zIndex = 20;
  export let arrowZIndex = 21;
  export let opacity = 1;
  export let arrowId = "arrowhead-main";
  export let showTValue = false;
  export let tValue: number | null = null;
  export let onImageSettled: () => void = () => {};

  const DEFAULT_ROBOT_IMAGE = "/robot.png";

  $: arrowLength = settings.headingArrowLength || 50;
  $: arrowColor = settings.headingArrowColor || "#ffffff";
  $: arrowRadians = (-heading * Math.PI) / 180;
</script>

<img
  src={settings.robotImage || DEFAULT_ROBOT_IMAGE}
  {alt}
  style={`position: absolute; top: ${xy.y}px;
left: ${xy.x}px; transform: translate(-50%, -50%) rotate(${heading}deg); z-index: ${zIndex}; width: ${widthPx}px; height: ${heightPx}px;user-select: none; -webkit-user-select: none; -moz-user-select: none;-ms-user-select: none;
pointer-events: none; opacity: ${opacity};`}
  draggable="false"
  on:load={onImageSettled}
  on:error={(e) => {
    console.error("Failed to load robot image:", settings.robotImage);
    onImageSettled();
    (e.currentTarget as HTMLImageElement).src = DEFAULT_ROBOT_IMAGE;
  }}
  on:dragstart={(e) => e.preventDefault()}
  on:selectstart={(e) => e.preventDefault()}
/>

{#if showTValue && tValue !== null}
  <div
    class="pointer-events-none absolute z-22 rounded-full border border-white/20 bg-black/60 px-3.5 py-1.5 font-mono text-[22px] font-semibold leading-none tracking-wide text-white shadow-lg backdrop-blur-sm"
    style={`left: ${xy.x}px; top: ${xy.y - heightPx / 2 - 14}px; transform: translate(-50%, -100%);`}
  >
    t {tValue.toFixed(3)}
  </div>
{/if}

{#if settings.showHeadingArrow}
  <svg
    style={`position: absolute; top: ${xy.y}px; left: ${xy.x}px; z-index: ${arrowZIndex}; pointer-events: none; overflow: visible; opacity: ${opacity};`}
    width="1"
    height="1"
  >
    <defs>
      <marker
        id={arrowId}
        markerWidth="10"
        markerHeight="10"
        refX="6.5"
        refY="3"
        orient="auto"
      >
        <polygon points="0 0, 7 3, 0 6" fill={arrowColor} />
      </marker>
    </defs>
    <line
      x1="0"
      y1="0"
      x2={arrowLength * Math.cos(arrowRadians)}
      y2={arrowLength * -Math.sin(arrowRadians)}
      stroke={arrowColor}
      stroke-width={settings.headingArrowThickness || 3}
      marker-end="url(#{arrowId})"
    />
  </svg>
{/if}
