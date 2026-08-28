<script lang="ts">
  import type { BasePoint } from "../../types";
  export let robotXY: BasePoint;
  export let robotHeading: number;
  export let x: d3.ScaleLinear<number, number>;
  export let y: d3.ScaleLinear<number, number>;
</script>

<div class="flex flex-col w-full justify-start items-start gap-2 text-sm">
  <div class="font-semibold">Current Robot Position</div>
  <div class="grid w-full grid-cols-1 gap-1.5 text-[12px]">
    <div class="flex items-center justify-between gap-2 rounded border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
      <div class="font-extralight text-gray-400">X</div>
      <div class="font-medium text-gray-100">{x.invert(robotXY.x).toFixed(3)}</div>
    </div>
    <div class="flex items-center justify-between gap-2 rounded border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
      <div class="font-extralight text-gray-400">Y</div>
      <div class="font-medium text-gray-100">{y.invert(robotXY.y).toFixed(3)}</div>
    </div>
    <div class="flex items-center justify-between gap-2 rounded border border-[#333333] bg-[#1f1f1f] px-2 py-1.5">
      <div class="font-extralight text-gray-400">Heading</div>
      <div class="font-medium text-gray-100">
        {robotHeading.toFixed(0) === "-0" ? "0" : -robotHeading.toFixed(0)}&deg;
      </div>
    </div>
  </div>
</div>
