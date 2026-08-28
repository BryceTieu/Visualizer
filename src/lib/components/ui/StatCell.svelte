<script lang="ts">
  export let label: string;
  /** Roomier padding for cells that hold controls rather than a bare value. */
  export let roomy = false;
  export let valueClass = "font-medium text-gray-100";
</script>

<div
  class="border border-[#333333] bg-[#1f1f1f] px-2"
  class:py-1.5={!roomy}
  class:py-2={roomy}
  class:leading-tight={roomy}
>
  <div class="text-gray-500">{label}</div>
  <div class={valueClass}><slot /></div>
</div>
