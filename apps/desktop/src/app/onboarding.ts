import { checkServerReachable, normalizeServerUrl, setStoredServerUrl } from "./serverConfig";

export function renderOnboarding(container: HTMLElement, onDone: (url: string) => void): void {
  container.innerHTML = `
    <div class="onboarding-screen">
      <div class="onboarding-card">
        <div class="onboarding-logo">RuCord</div>
        <h1>Подключение к серверу</h1>
        <p class="onboarding-hint">
          Введи адрес твоего self-host RuCord сервера. Если ты ещё не поднял свой —
          попроси у того, кто им владеет (это администратор сообщества).
        </p>
        <form id="onboarding-form" class="onboarding-form" autocomplete="off">
          <label for="onboarding-url">Адрес сервера</label>
          <input id="onboarding-url" name="url" placeholder="rucord.example.com" required />
          <div class="onboarding-error" id="onboarding-error" hidden></div>
          <button type="submit" class="primary" id="onboarding-submit">Подключиться</button>
        </form>
        <div class="onboarding-footer">
          <span>Адрес сохранится локально. Сменить можно будет в настройках.</span>
        </div>
      </div>
    </div>
  `;

  const form = container.querySelector<HTMLFormElement>("#onboarding-form")!;
  const input = container.querySelector<HTMLInputElement>("#onboarding-url")!;
  const errorEl = container.querySelector<HTMLDivElement>("#onboarding-error")!;
  const submit = container.querySelector<HTMLButtonElement>("#onboarding-submit")!;

  input.focus();

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
      const message = err instanceof Error ? err.message : "Не удалось достучаться до сервера";
      errorEl.textContent = `Не удалось подключиться: ${message}. Проверь адрес и попробуй ещё раз.`;
      errorEl.hidden = false;
      submit.disabled = false;
      submit.textContent = "Подключиться";
    }
  });
}
