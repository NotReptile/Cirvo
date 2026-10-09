export function externalHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

let installed = false;
export function installExternalLinks(): void {
  if (installed || !("__TAURI_INTERNALS__" in window)) return;
  installed = true;
  document.addEventListener("click", event => {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[target="_blank"]');
    if (!link) return;
    event.preventDefault();
    const url = externalHttpUrl(link.href);
    if (url) void import("@tauri-apps/plugin-opener").then(p => p.openUrl(url)).catch(() => {
      console.warn("Не удалось открыть ссылку в системном браузере");
    });
  });
}
