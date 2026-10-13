/** Read only the build-owned static product metadata, never user or tenant input. */
export function getApplicationName(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>(
    'meta[name="application-name"]',
  )?.content || undefined;
}

export function setApplicationDocumentTitle(nativeTitle: string): void {
  document.title = getApplicationName() || nativeTitle;
}

export function getApplicationMarkUrl(dark: boolean): string | undefined {
  if (!getApplicationName()) return undefined;
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href;
  return icon ? new URL(dark ? "mark-white.svg" : "mark-black.svg", icon).href : undefined;
}
