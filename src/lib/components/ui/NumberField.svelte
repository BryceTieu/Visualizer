<script lang="ts">
  export let id: string;
  export let label: string;
  export let description = "";
  export let value: number | undefined;
  export let min: number | undefined = undefined;
  export let max: number | undefined = undefined;
  export let step: number | string | undefined = undefined;
  export let suffix = "";
  export let disabled = false;
  export let inputClass = "console-input px-3 py-2";
  export let onInput: (rawValue: string) => void;
</script>

<div>
  <label
    for={id}
    class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1"
  >
    {label}
    {#if description}
      <div class="text-xs text-neutral-500 dark:text-neutral-400">
        {description}
      </div>
    {/if}
  </label>
  <div class:flex={Boolean(suffix)} class:items-center={Boolean(suffix)} class:gap-2={Boolean(suffix)}>
    <input
      {id}
      type="number"
      {value}
      {min}
      {max}
      {step}
      {disabled}
      on:input={(e) => onInput(e.currentTarget.value)}
      class="{inputClass} focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    {#if suffix}
      <span class="text-sm text-neutral-500 dark:text-neutral-400">{suffix}</span>
    {/if}
  </div>
</div>
