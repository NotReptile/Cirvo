import {
  INSECURE_SERVER_WARNING,
  ServerCheckError,
  checkServerReachable,
  isInsecureServerUrl,
  normalizeServerUrl,
  setStoredServerUrl
} from "./serverConfig";
import { CIRVO_MARK, CIRVO_TAGLINE } from "./brand";

export function renderOnboarding(container: HTMLElement, onDone: (url: string) => void): void {
  container.innerHTML = `
    <div class="onboarding-screen">
      <div class="onboarding-card">
        <div class="brand-lockup">
          ${CIRVO_MARK}
          <div class="brand-text">
            <div class="brand-name">Cirvo</div>
            <div class="brand-tagline">${CIRVO_TAGLINE}</div>
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
