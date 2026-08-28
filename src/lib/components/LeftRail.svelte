<script lang="ts">
  export let hidden = false;
  export let fileName: string;
  export let version: string;
  export let lineCount: number;
  export let pathPreviewItems: {
    index: number;
    lineIndex: number;
    name: string;
    x: string;
    y: string;
  }[];
  export let selectedLineIndex: number;
  export let onToggleVisibility: () => void;
  export let onSelectLine: (lineIndex: number) => void;
</script>

<aside
  class="panel-box side-rail side-rail-left"
  class:side-rail--collapsed={hidden}
>
  <section class="module-box">
    <div class="module-header-row">
      <h3 class="module-title">File</h3>
      <div class="flex items-center gap-2">
        <span class="module-chip">{version}</span>
        <button
          class="panel-toggle-btn"
          type="button"
          on:click={onToggleVisibility}
          aria-label={hidden ? "Show left panel" : "Hide left panel"}
          title={hidden ? "Show left panel" : "Hide left panel"}
        >
          {hidden ? "›" : "‹"}
        </button>
      </div>
    </div>
    <p class="module-caption">Export name</p>
    <div class="module-mono">{fileName}</div>
  </section>

  <section class="module-box module-fill">
    <div class="module-header-row">
      <h3 class="module-title">Path List</h3>
      <span class="module-caption">
        {lineCount} path{lineCount === 1 ? "" : "s"}
      </span>
    </div>
    <div class="module-list">
      {#each pathPreviewItems as item (item.index)}
        <button
          class="list-item-box compact text-left"
          class:list-item-box--selected={selectedLineIndex === item.lineIndex}
          on:click={() => onSelectLine(item.lineIndex)}
        >
          <div class="list-item-top">
            <span class="list-item-name">{item.name}</span>
          </div>
          <div class="list-item-sub">{item.x}, {item.y}</div>
        </button>
      {/each}
      {#if lineCount > pathPreviewItems.length}
        <div class="list-empty">
          + {lineCount - pathPreviewItems.length} more...
        </div>
      {/if}
    </div>
  </section>
</aside>
