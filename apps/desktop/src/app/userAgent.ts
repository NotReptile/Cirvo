// Читаемое описание сеанса вместо сырой строки User-Agent.

function detectOs(ua: string): string {
  if (/Windows NT 1[01]/.test(ua)) return "Windows";
  if (/Windows/.test(ua)) return "Windows";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "";
}

function detectBrowser(ua: string): string {
  // Порядок важен: Edge и Opera тоже содержат «Chrome», Chrome содержит «Safari».
  if (/Edg\//.test(ua)) return "Edge / WebView2";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "";
}

export function describeUserAgent(ua: string | undefined | null): string {
  if (!ua) return "";
  const parts = [detectOs(ua), detectBrowser(ua)].filter(Boolean);
  return parts.join(" · ");
}

// Метка устройства, которую клиент передаёт при входе.
export function describeDeviceLabel(label: string | undefined | null): string {
  if (!label) return "";
  if (label === "rucord-desktop") return "Приложение RuCord";
  return label;
}
