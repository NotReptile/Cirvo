// Общий знак и подпись бренда для экранов входа и подключения.
// Знак: V продета сквозь кольцо C («Circle and Voice»). Исходник:
// src-tauri/icons/icon-source.svg.
export const CIRVO_MARK = `<svg class="brand-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
  <defs>
    <mask id="cm-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect width="1024" height="1024" fill="white"/>
      <path d="M346 236 512 640 678 236" fill="none" stroke="black" stroke-width="172" stroke-linecap="round" stroke-linejoin="round"/>
    </mask>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="#6d28d9"/>
  <path d="M811 486A300 300 0 1 0 705 742" fill="none" stroke="#fff" stroke-width="96" stroke-linecap="round" mask="url(#cm-cut)"/>
  <path d="M346 236 512 640 678 236" fill="none" stroke="#22d3ee" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const CIRVO_TAGLINE = "Circle and Voice";
