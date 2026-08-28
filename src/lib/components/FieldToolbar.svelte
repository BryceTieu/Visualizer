<script lang="ts">
  import PlayIcon from "./icons/PlayIcon.svelte";
  import PauseIcon from "./icons/PauseIcon.svelte";

  export let playing = false;
  export let penToolEnabled = false;
  export let onAddPath: () => void;
  export let onTogglePenTool: () => void;
  export let onAddControlPoint: () => void;
  export let onRemoveControlPoint: () => void;
  export let onCreatePathToLastPoint: () => void;
  export let onTogglePlay: () => void;
</script>

<div class="center-toolbar">
  <button class="toolbar-btn" on:click={onAddPath}>+ Add Path</button>
  <button
    class="toolbar-btn"
    class:toolbar-btn--blue={penToolEnabled}
    on:click={onTogglePenTool}
  >
    {penToolEnabled ? "Pen Tool On" : "Pen Tool"}
  </button>
  <button class="toolbar-btn" on:click={onAddControlPoint}>+ Control Point</button>
  <button class="toolbar-btn" on:click={onRemoveControlPoint}>- Control Point</button>
  <button class="toolbar-btn toolbar-btn--blue" on:click={onCreatePathToLastPoint}>
    Create Path to Last Point
  </button>
  <div style="flex: 1;"></div>
  <button
    class="toolbar-btn toolbar-btn--icon"
    title={playing ? "Pause" : "Play"}
    aria-label={playing ? "Pause" : "Play"}
    on:click={onTogglePlay}
  >
    {#if playing}
      <PauseIcon className="size-5" strokeWidth={2} />
    {:else}
      <PlayIcon className="size-5" strokeWidth={2} />
    {/if}
  </button>
</div>
