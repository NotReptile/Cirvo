import {
  INSECURE_SERVER_WARNING,
  ServerCheckError,
  checkServerReachable,
  isInsecureServerUrl,
  normalizeServerUrl,
  setStoredServerUrl
} from "./serverConfig";

// Знак Cirvo: V продета сквозь кольцо C («Circle and Voice»). Исходник:
// src-tauri/icons/icon-source.svg.
const CIRVO_MARK = `
  <svg class="onboarding-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
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

export function renderOnboarding(container: HTMLElement, onDone: (url: string) => void): void {
  container.innerHTML = `
    <div class="onboarding-screen">
      <div class="onboarding-card">
        <div class="onboarding-brand">
          ${CIRVO_MARK}
          <div class="onboarding-brand-text">
            <div class="onboarding-logo">Cirvo</div>
            <div class="onboarding-tagline">Circle and Voice</div>
          </div>
        </div>
        <h1>Подключение к серверу</h1>
        <p class="onboarding-hint">
          Введи адрес своего Cirvo-сервера. Если своего нет, спроси его у администратора сообщества.
        </p>
        <form id="onboarding-form" class="onboarding-form" autocomplete="off">
          <label for="onboarding-url">Адрес сервера</label>
          <input id="onboarding-url" name="url" placeholder="chat.example.com или 203.0.113.10" spellcheck="false" required />
          <div class="onboarding-warning" id="onboarding-warning" role="status" hidden></div>
          <div class="onboarding-error" id="onboarding-error" role="alert" aria-live="polite" hidden></div>
          <button type="submit" class="primary" id="onboarding-submit">Подключиться</button>
        </form>
        <div class="onboarding-footer">
          <span>Адрес сохранится локально. Сменить его можно в настройках (раздел «Сервер») или на экране входа.</span>
        </div>
      </div>
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>("#onboarding-form")!;
  const input = container.querySelector<HTMLInputElement>("#onboarding-url")!;
  const errorEl = container.querySelector<HTMLDivElement>("#onboarding-error")!;
  const warningEl = container.querySelector<HTMLDivElement>("#onboarding-warning")!;
  const submit = container.querySelector<HTMLButtonElement>("#onboarding-submit")!;

  input.focus();

  // Предупреждение о http показывается сразу, пока адрес набирается.
  input.addEventListener("input", () => {
    const raw = input.value.trim();
    const insecure = raw !== "" && isInsecureServerUrl(raw);
    warningEl.textContent = insecure ? INSECURE_SERVER_WARNING : "";
    warningEl.hidden = !insecure;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const url = normalizeServerUrl(raw);
    errorEl.hidden = true;
    submit.disabled = true;
    submit.textContent = "Проверка…";
    try {
      await checkServerReachable(url);
      setStoredServerUrl(url);
      onDone(url);
    } catch (err) {
      errorEl.textContent = err instanceof ServerCheckError
        ? err.message
        : "Не удалось подключиться к серверу. Проверь адрес и попробуй ещё раз.";
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Подключиться";
    }
  });
}
