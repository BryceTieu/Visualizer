<script lang="ts">
  import type { FileInfo } from "../../types";
  import PencilIcon from "./icons/PencilIcon.svelte";
  import TrashIcon from "./icons/TrashIcon.svelte";

  export let file: FileInfo;
  export let isPrimary = false;
  export let isSecondary = false;
  export let renaming = false;
  export let renameValue = "";
  export let formatFileSize: (bytes: number) => string;
  export let formatDate: (date: Date) => string;
  export let onActivate: (file: FileInfo) => void;
  export let onStartRename: (file: FileInfo) => void;
  export let onConfirmRename: () => void;
  export let onCancelRename: () => void;
  export let onDelete: (file: FileInfo) => void;

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") onActivate(file);
  }

  function handleRenameKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") onConfirmRename();
    if (event.key === "Escape") onCancelRename();
  }
</script>

<div
  class="px-3 py-1.5 border-b border-neutral-200 dark:border-neutral-700 transition-colors duration-250 cursor-pointer file-item group"
  on:click={() => onActivate(file)}
  on:keydown={handleKeydown}
  role="button"
  tabindex="0"
  aria-label={`Open ${file.name}`}
  class:bg-blue-50={isPrimary}
  class:dark:bg-blue-900={isPrimary}
  class:bg-purple-50={isSecondary}
  class:dark:bg-purple-900={isSecondary}
>
  {#if renaming}
    <!-- Rename Input -->
    <div class="space-y-2">
      <input
        bind:value={renameValue}
        class="w-full px-2 py-1 text-sm border border-blue-300 dark:border-blue-600 rounded bg-white dark:bg-neutral-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
        on:keydown={handleRenameKeydown}
      />
      <div class="flex gap-2">
        <button
          on:click|stopPropagation={onConfirmRename}
          class="px-2 py-1 text-xs bg-green-500 hover:bg-green-600 text-white rounded transition-colors"
        >
          Save
        </button>
        <button
          on:click|stopPropagation={onCancelRename}
          class="px-2 py-1 text-xs bg-neutral-500 hover:bg-neutral-600 text-white rounded transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <!-- Normal File Display -->
    <div class="flex items-center justify-between gap-2">
      <div class="flex-1 min-w-0">
        <div
          class="font-medium text-sm truncate text-neutral-900 dark:text-white"
          title={file.name}
        >
          {file.name}
          {#if file.error}
            <span class="ml-2 text-xs text-red-500">({file.error})</span>
          {/if}
        </div>
        <div
          class="text-xs text-neutral-500 dark:text-neutral-400 group-hover:block hidden"
          title="{formatFileSize(file.size)} • {formatDate(file.modified)}"
        >
          {formatFileSize(file.size)} • {formatDate(file.modified)}
        </div>
      </div>

      <div
        class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <button
          on:click|stopPropagation={() => onStartRename(file)}
          class="p-1.5 rounded hover:bg-blue-500 hover:text-white transition-colors shrink-0"
          title="Rename file"
        >
          <PencilIcon />
        </button>

        <button
          on:click|stopPropagation={() => onDelete(file)}
          class="p-1.5 rounded hover:bg-red-500 hover:text-white transition-colors shrink-0"
          title="Delete file"
        >
          <TrashIcon className="size-4" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .file-item {
    transition: all 0.2s ease;
  }

  .file-item:hover {
    transform: translateX(2px);
  }
</style>
