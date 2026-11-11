import React from "react";
import { palette } from "./app-model.js";
import { ShimmerText, useShimmerFrame } from "./app-motion.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

export const ZCODE_LOGO_LINES = [
  "███████╗ ██████╗ ██████╗ ██████╗ ███████╗",
  "   ███╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "  ███╔╝ ██║     ██║   ██║██║  ██║█████╗  ",
  " ███╔╝  ██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████╗╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
] as const;

const EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT = ZCODE_LOGO_LINES.length;

export function EmptyTranscriptLogo({
  animated = false,
  applicationName,
}: {
  animated?: boolean;
  applicationName?: string;
} = {}): React.ReactElement {
  // 字符画也是产品展示；自定义发行复用已校验名称，不再绘制原生 ZCODE 字标。
  const lines =
    applicationName && applicationName !== "ZCode" ? [applicationName] : ZCODE_LOGO_LINES;
  if (animated) {
    return h(AnimatedEmptyTranscriptLogo, { lines });
  }
  return renderLogoContent({ animated: false, lines });
}

function AnimatedEmptyTranscriptLogo({ lines }: { lines: readonly string[] }): React.ReactElement {
  const frameMs = useShimmerFrame(true);
  return renderLogoContent({ animated: true, frameMs, lines });
}

function renderLogoContent(input: {
  animated: boolean;
  frameMs?: number;
  lines: readonly string[];
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        minHeight: EMPTY_TRANSCRIPT_LOGO_MIN_HEIGHT,
        width: "100%",
      },
    },
    ...input.lines.map((line, index) =>
      renderLogoText({
        animated: input.animated,
        baseColor: palette.accent,
        frameMs: input.frameMs,
        key: `zcode-logo-${index}`,
        text: line,
      }),
    ),
  );
}

function renderLogoText(input: {
  animated: boolean;
  baseColor: string;
  frameMs?: number;
  key: string;
  text: string;
}): React.ReactElement {
  if (!input.animated) {
    return h("text", { key: input.key, style: { fg: input.baseColor } }, input.text);
  }
  return h(ShimmerText, {
    animated: true,
    baseColor: input.baseColor,
    frameMs: input.frameMs,
    highlightColor: palette.text,
    key: input.key,
    text: input.text,
  });
}
