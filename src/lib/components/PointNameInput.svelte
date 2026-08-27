<script lang="ts">
  import type { Point } from "../../types";

  export let point: Point;
  export let title = "Point Name";
  export let placeholder = "Enter point name";

  function handleInput(event: Event) {
    point.name = (event.currentTarget as HTMLInputElement).value;
  }
</script>

<div class="flex flex-col w-full justify-start items-start gap-2">
  <div class="flex items-start justify-between w-full gap-2">
    <div class="font-semibold flex items-center gap-2">
      {title}
    </div>
  </div>

  <div class="grid w-full grid-cols-1 gap-2">
    <label class="flex flex-col gap-1 text-xs w-full">
      <span class="font-extralight">Name</span>
      <input
        value={point.name ?? ""}
        type="text"
        placeholder={placeholder}
        class="w-full rounded-md border-[0.5px] bg-neutral-100 px-2 py-1 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950"
        on:input={handleInput}
        disabled={point.locked}
      />
    </label>
  </div>
</div>