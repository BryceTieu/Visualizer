<script lang="ts">
  import { cubicInOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";

  export let isOpen = false;
  export let titleId = "";
  export let panelClass = "console-panel p-6 w-full max-w-md mx-4";
  export let closeOnEscape = true;
  export let closeOnBackdrop = true;
  export let onClose: () => void = () => {};

  const BACKDROP_MS = 200;
  const PANEL_MS = 300;

  function handleKeydown(event: KeyboardEvent) {
    if (closeOnEscape && event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent) {
    if (closeOnBackdrop && event.target === event.currentTarget) {
      onClose();
    }
  }
</script>

<svelte:window on:keydown={isOpen ? handleKeydown : undefined} />

{#if isOpen}
  <!-- Backdrop is presentational; Escape is handled on window above. -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div
    transition:fade={{ duration: BACKDROP_MS, easing: cubicInOut }}
    class="console-backdrop fixed inset-0 z-2000 flex items-center justify-center"
    on:click={handleBackdropClick}
  >
    <div
      transition:fly={{ duration: PANEL_MS, easing: cubicInOut, y: -20 }}
      class={panelClass}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId || undefined}
      tabindex="-1"
    >
      <slot />
    </div>
  </div>
{/if}
