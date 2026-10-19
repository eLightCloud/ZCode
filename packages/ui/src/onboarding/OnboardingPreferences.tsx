import { Checkbox } from "@/components/ui/checkbox.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";

type Preference = "suggestions" | "memory" | "migration";

/** 只展示偏好选项；作答、模式切换及保存仍由原生引导 owner 负责。 */
export function OnboardingPreferences({
  mode,
  values,
  saving,
  t,
  onChange,
}: {
  mode: InterfaceMode | null;
  values: Record<Preference, boolean>;
  saving: boolean;
  t: (key: string) => string;
  onChange: (key: Preference, value: boolean) => void;
}) {
  return (
    <div className="mt-8 space-y-3">
      {(["suggestions", "memory", "migration"] as const)
        .filter((key) => key !== "suggestions" || mode === "office")
        .map((key) => (
          <label
            key={key}
            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
          >
            <Checkbox
              checked={values[key]}
              disabled={saving}
              onCheckedChange={(checked) => onChange(key, checked === true)}
            />
            <span className="font-medium">{t(key)}</span>
            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
              {t(`${key}Description`)}
            </span>
          </label>
        ))}
    </div>
  );
}
