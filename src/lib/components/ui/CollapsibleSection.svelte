<script lang="ts">
  import ChevronDownIcon from "../icons/ChevronDownIcon.svelte";

  export let title: string;
  export let collapsed = true;
  /** Heroicon `d` path for the leading icon; omit to render title only. */
  export let iconPath = "";
  export let onToggle: () => void;
</script>

<div class="mb-4">
  <button
    on:click={onToggle}
    class="console-trigger w-full justify-between transition-colors duration-250"
    aria-expanded={!collapsed}
  >
    <div class="flex items-center gap-2">
      {#if iconPath}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width={1.5}
          stroke="currentColor"
          class="size-5"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d={iconPath} />
        </svg>
      {/if}
      <span class="font-semibold">{title}</span>
    </div>
    <ChevronDownIcon
      className="size-5 transition-transform duration-200"
      rotated={collapsed}
    />
  </button>

  {#if !collapsed}
    <slot />
  {/if}
</div>
