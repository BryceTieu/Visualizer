<script lang="ts">
  import { cubicInOut } from "svelte/easing";
  import { fade, fly } from "svelte/transition";

  export let isOpen = false;
  export let title = "Enter Name";
  export let defaultValue = "";
  export let placeholder = "Enter name...";
  export let onConfirm: (name: string) => void = () => {};
  export let onCancel: () => void = () => {};

  let inputValue = defaultValue;
  let inputElement: HTMLInputElement;
  let lastOpenState = false;

  // Only initialize when dialog first opens, not on every reactive update
  $: if (isOpen && !lastOpenState) {
    lastOpenState = true;
    inputValue = defaultValue;
    setTimeout(() => {
      inputElement?.focus();
      inputElement?.select();
    }, 100);
  } else if (!isOpen) {
    lastOpenState = false;
  }

  function handleConfirm() {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onConfirm(trimmed);
      isOpen = false;
    }
  }

  function handleCancel() {
    onCancel();
    isOpen = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      handleConfirm();
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleCancel();
    }
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    transition:fade={{ duration: 200, easing: cubicInOut }}
    class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[2000]"
    on:click={handleCancel}
    role="presentation"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      transition:fly={{ duration: 300, easing: cubicInOut, y: -20 }}
      class="bg-white dark:bg-neutral-800 rounded-lg shadow-2xl p-6 w-full max-w-md mx-4"
      on:click|stopPropagation
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      tabindex="-1"
    >
      <h2
        id="dialog-title"
        class="text-xl font-semibold text-neutral-900 dark:text-neutral-100 mb-4"
      >
        {title}
      </h2>

      <div class="mb-6">
        <input
          bind:this={inputElement}
          bind:value={inputValue}
          on:keydown={handleKeydown}
          type="text"
          {placeholder}
          class="w-full px-4 py-3 rounded-lg border-2 border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
        />
      </div>

      <div class="flex justify-end gap-3">
        <button
          on:click={handleCancel}
          class="px-4 py-2 rounded-lg text-neutral-700 dark:text-neutral-300 bg-neutral-200 dark:bg-neutral-700 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors font-medium"
        >
          Cancel
        </button>
        <button
          on:click={handleConfirm}
          disabled={!inputValue.trim()}
          class="px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:bg-neutral-400 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Confirm
        </button>
      </div>
    </div>
  </div>
{/if}
