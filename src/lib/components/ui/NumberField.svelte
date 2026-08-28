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

  let focused = false;
  let text = "";

  // Mirror the prop while the user is not editing. During editing the field
  // owns its text so partial input ("8" on a min-180 field) is not clamped
  // out from under the caret.
  $: if (!focused) text = value === undefined ? "" : String(value);

  function inRange(n: number): boolean {
    if (Number.isNaN(n)) return false;
    if (min !== undefined && n < min) return false;
    if (max !== undefined && n > max) return false;
    return true;
  }

  function handleInput(event: Event) {
    text = (event.currentTarget as HTMLInputElement).value;
    // Only push through while the typed value is already valid; anything
    // partial waits for blur so it does not get clamped mid-keystroke.
    if (inRange(parseFloat(text))) onInput(text);
  }

  function commit() {
    const parsed = parseFloat(text);
    const fallback = min ?? 0;
    const clamped = Number.isNaN(parsed)
      ? fallback
      : Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    text = String(clamped);
    onInput(text);
  }

  function handleBlur() {
    focused = false;
    commit();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") commit();
  }
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
      value={text}
      {min}
      {max}
      {step}
      {disabled}
      on:input={handleInput}
      on:focus={() => (focused = true)}
      on:blur={handleBlur}
      on:keydown={handleKeydown}
      class="{inputClass} focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
    {#if suffix}
      <span class="text-sm text-neutral-500 dark:text-neutral-400">{suffix}</span>
    {/if}
  </div>
</div>
