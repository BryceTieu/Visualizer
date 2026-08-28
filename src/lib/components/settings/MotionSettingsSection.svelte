<script lang="ts">
  import type { Settings } from "../../../types";
  import NumberField from "../ui/NumberField.svelte";
  import {
    clampNumberInput,
    type NumericSettingKey,
  } from "../../settings/numericSetting";

  interface Props {
    settings: Settings;
  }

  let { settings = $bindable() }: Props = $props();

  let angularVelocityDisplay = $derived(
    settings ? settings.aVelocity / Math.PI : 1,
  );

  function setNumber(
    value: string,
    property: NumericSettingKey,
    min?: number,
    max?: number,
  ) {
    settings[property] = clampNumberInput(value, min, max);
  }

  function setAngularVelocity(value: string) {
    const parsed = parseFloat(value);
    settings.aVelocity = (Number.isNaN(parsed) ? 0 : parsed) * Math.PI;
  }
</script>

<div class="mt-2 space-y-3 p-3 bg-neutral-50 dark:bg-neutral-800/50 rounded-lg">
  <!-- Velocity Settings -->
  <div class="grid grid-cols-2 gap-3">
    <NumberField
      id="x-velocity"
      label="X Velocity (in/s)"
      value={settings.xVelocity}
      min={0}
      step={1}
      onInput={(v) => setNumber(v, "xVelocity", 0)}
    />

    <NumberField
      id="y-velocity"
      label="Y Velocity (in/s)"
      value={settings.yVelocity}
      min={0}
      step={1}
      onInput={(v) => setNumber(v, "yVelocity", 0)}
    />
  </div>

  <!-- Angular Velocity -->
  <NumberField
    id="angular-velocity"
    label="Angular Velocity (π rad/s)"
    description="Multiplier of π radians per second"
    value={angularVelocityDisplay}
    min={0}
    step={0.1}
    onInput={setAngularVelocity}
  />

  <!-- Velocity Limits -->
  <NumberField
    id="max-velocity"
    label="Max Velocity (in/s)"
    value={settings.maxVelocity}
    min={0}
    step={1}
    onInput={(v) => setNumber(v, "maxVelocity", 0)}
  />

  <!-- Acceleration Limits -->
  <div class="grid grid-cols-2 gap-3">
    <NumberField
      id="max-acceleration"
      label="Max Acceleration (in/s²)"
      value={settings.maxAcceleration}
      min={0}
      step={1}
      onInput={(v) => setNumber(v, "maxAcceleration", 0)}
    />

    <NumberField
      id="max-deceleration"
      label="Max Deceleration (in/s²)"
      value={settings.maxDeceleration || settings.maxAcceleration}
      min={0}
      step={1}
      onInput={(v) => setNumber(v, "maxDeceleration", 0)}
    />
  </div>

  <!-- Friction -->
  <NumberField
    id="friction-coefficient"
    label="Friction Coefficient"
    description="Higher values = more resistance"
    value={settings.kFriction}
    min={0}
    step={0.1}
    onInput={(v) => setNumber(v, "kFriction", 0)}
  />
</div>
