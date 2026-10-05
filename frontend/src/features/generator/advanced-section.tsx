import { useI18n } from "@/hooks/use-i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { C } from "./palette";

/**
 * The Generator panel's Advanced fields, ported from civitai's
 * `generation_v2` Advanced accordion (their Mantine `SliderInput`
 * and `SeedInput`) onto kawai's Radix primitives. Only the fields
 * the imageGen recipe wire carries — cfgScale, steps and seed.
 * civitai's sampler / clipSkip / vae / controlNets have no field
 * in `civitai::ImageGenParams`, so porting them would be dead UI.
 */

/** civitai's seed bounds (shared/constants/generation.constants.ts):
 *  uint32 max for input, signed 32-bit max for the random roll. */
const MAX_SEED = 4294967295;
const MAX_RANDOM_SEED = 2147483647;

interface Preset {
  label: string;
  value: number;
}

interface SliderFieldProps {
  id: string;
  label: string;
  /** String state — the panel keeps cfgScale/steps as strings. */
  value: string;
  min: number;
  max: number;
  step?: number;
  presets: Preset[];
  onChange: (value: string) => void;
}

/** Slider + number-input pair (civitai's SliderInput) — both write
 *  the same string state, so the slider thumb and the input never
 *  disagree. Preset chips sit right of the label, civitai-style. */
function SliderField({ id, label, value, min, max, step = 1, presets, onChange }: SliderFieldProps) {
  const numeric = Number(value) || 0;
  const clamped = Math.min(Math.max(numeric, min), max);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[13px] font-medium" htmlFor={id} style={{ color: C.muted }}>
          {label}
        </Label>
        <div className="flex flex-wrap items-center gap-1">
          {presets.map((preset) => {
            const active = clamped === preset.value;
            return (
              <button
                key={preset.value}
                type="button"
                onClick={() => onChange(String(preset.value))}
                className={cn("rounded px-2 py-0.5 text-xs transition-colors", !active && "hover:opacity-80")}
                style={{
                  backgroundColor: active ? C.blue : C.hover,
                  color: active ? "#FFFFFF" : C.text,
                }}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Slider
          className="flex-1"
          value={[clamped]}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange(String(v[0]))}
        >
          <SliderTrack style={{ backgroundColor: C.border }}>
            <SliderRange style={{ backgroundColor: C.blue }} />
          </SliderTrack>
          <SliderThumb
            aria-label={label}
            className="border-2 bg-[#4263EB] shadow-none"
            style={{ borderColor: "rgba(255, 255, 255, 0.7)" }}
          />
        </Slider>
        <Input
          className="h-8 w-[64px] flex-none rounded-[8px] focus-visible:ring-0"
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ backgroundColor: C.input, borderColor: C.border, color: C.text }}
        />
      </div>
    </div>
  );
}

interface SeedFieldProps {
  /** Empty string = random seed on the wire (`seed: undefined`). */
  seed: string;
  onChange: (value: string) => void;
}

/** Random/Custom segmented control + seed input (civitai's
 *  SeedInput). Picking Custom rolls a random seed like civitai
 *  does; clearing the input (or picking Random) sends no seed,
 *  which the backend maps to `None` = random. */
function SeedField({ seed, onChange }: SeedFieldProps) {
  const { t } = useI18n();
  const custom = seed.trim() !== "";
  const options = [
    { id: "random", label: t("generator.seedRandom"), active: !custom },
    { id: "custom", label: t("generator.seedCustom"), active: custom },
  ] as const;
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
        {t("generator.seed")}
      </Label>
      <div className="flex items-center gap-2">
        <div
          role="radiogroup"
          className="flex flex-1 rounded-md p-0.5"
          style={{ backgroundColor: C.input, border: `1px solid ${C.border}` }}
        >
          {options.map((option) => (
            <label
              key={option.id}
              className={cn(
                "flex flex-1 cursor-pointer items-center justify-center rounded-[6px] px-2 py-1 text-xs font-medium transition-colors",
                !option.active && "hover:opacity-80",
              )}
              style={{
                backgroundColor: option.active ? C.hover : "transparent",
                color: option.active ? C.heading : C.muted,
              }}
            >
              <input
                type="radio"
                name="generator-seed-mode"
                className="sr-only"
                checked={option.active}
                onChange={() => {
                  if (option.id === "random") {
                    onChange("");
                  } else if (!custom) {
                    // civitai rolls a seed when switching to custom
                    onChange(String(Math.floor(Math.random() * MAX_RANDOM_SEED)));
                  }
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
        <Input
          className="h-8 w-[96px] flex-none rounded-[8px] focus-visible:ring-0"
          id="generator-seed"
          type="number"
          min={0}
          max={MAX_SEED}
          placeholder={t("generator.seedPlaceholder")}
          value={seed}
          onChange={(e) => onChange(e.target.value)}
          style={{ backgroundColor: C.input, borderColor: C.border, color: C.text }}
        />
      </div>
    </div>
  );
}

export interface AdvancedSectionProps {
  cfgScale: string;
  steps: string;
  seed: string;
  onCfgScale: (value: string) => void;
  onSteps: (value: string) => void;
  onSeed: (value: string) => void;
}

export function AdvancedSection({ cfgScale, steps, seed, onCfgScale, onSteps, onSeed }: AdvancedSectionProps) {
  const { t } = useI18n();
  // civitai's SD-graph preset chips (stable-diffusion-graph.ts):
  // cfg 4/7/10, steps 20/30/40 — all inside kawai's wider
  // 0–30 / 1–150 wire bounds.
  const cfgPresets = [
    { label: t("generator.presetCreative"), value: 4 },
    { label: t("generator.presetBalanced"), value: 7 },
    { label: t("generator.presetPrecise"), value: 10 },
  ];
  const stepsPresets = [
    { label: t("generator.presetFast"), value: 20 },
    { label: t("generator.presetBalanced"), value: 30 },
    { label: t("generator.presetHigh"), value: 40 },
  ];
  return (
    <div className="flex flex-col gap-3">
      <SliderField
        id="generator-cfg"
        label={t("generator.cfgScale")}
        value={cfgScale}
        min={0}
        max={30}
        step={0.5}
        presets={cfgPresets}
        onChange={onCfgScale}
      />
      <SliderField
        id="generator-steps"
        label={t("generator.steps")}
        value={steps}
        min={1}
        max={150}
        presets={stepsPresets}
        onChange={onSteps}
      />
      <SeedField seed={seed} onChange={onSeed} />
    </div>
  );
}
