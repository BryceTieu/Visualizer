<script lang="ts">
  export let side: "left" | "right";
  export let hidden = false;
  export let onResizeStart: (side: "left" | "right", event: MouseEvent) => void;
  export let onRestore: () => void;

  $: label = side === "left" ? "left" : "right";
  // The chevron points toward the direction the panel would reappear from.
  $: collapsedGlyph = side === "left" ? "›" : "‹";
</script>

<div class="panel-divider panel-divider--{side}">
  <button
    class="panel-divider-grip"
    type="button"
    aria-label="Resize {label} panel"
    title={hidden
      ? `Click to restore the ${label} panel`
      : `Drag to resize the ${label} panel`}
    on:mousedown={(event) => onResizeStart(side, event)}
    on:click={() => {
      if (hidden) onRestore();
    }}
  >
    {#if hidden}
      {collapsedGlyph}
    {:else}
      <span class="panel-divider-line"></span>
    {/if}
  </button>
</div>
