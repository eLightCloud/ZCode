import { FileText, MessageSquare, Puzzle } from "lucide-react";

/** 介绍复用原生引导正文，不持有偏好、完成记录或企业状态。 */
export function OnboardingIntroduction({ t }: { t: (key: string) => string }) {
  return (
    <div className="mt-8 space-y-5 text-left">
      {[
        { key: "Chat", Icon: MessageSquare },
        { key: "Files", Icon: FileText },
        { key: "Skills", Icon: Puzzle },
      ].map(({ key, Icon }) => (
        <div key={key} className="flex items-start gap-3">
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-foreground-subtle" />
          <div className="min-w-0">
            <h2 className="text-ui-base font-medium">{t(`introduction${key}Title`)}</h2>
            <p className="mt-1 text-ui-sm leading-relaxed text-foreground-subtle">
              {t(`introduction${key}Description`)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
