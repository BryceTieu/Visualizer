<script lang="ts">
  export let src: string;
  export let fieldMapName: string | undefined;
  export let onSettled: () => void = () => {};

  const FALLBACK_FIELD_MAP = "/fields/decode.webp";
</script>

<img
  {src}
  alt="Field"
  class="absolute top-0 left-0 w-full h-full rounded-lg z-10"
  style="
    background: transparent;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
    user-drag: none;
    -webkit-user-drag: none;
    -moz-user-drag: none;
    -ms-user-drag: none;
    -o-user-drag: none;
  "
  draggable="false"
  on:load={onSettled}
  on:error={(e) => {
    console.error("Failed to load field map:", fieldMapName);
    onSettled();
    (e.currentTarget as HTMLImageElement).src = FALLBACK_FIELD_MAP;
  }}
  on:dragstart={(e) => e.preventDefault()}
  on:selectstart={(e) => e.preventDefault()}
/>
