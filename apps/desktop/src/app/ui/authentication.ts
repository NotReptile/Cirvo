import type { ApiError } from "../../network/httpClient";
import { confirmDialog } from "../dialogs";
import { bindEvent } from "../dom";
import { describeError } from "../errors";
import { requestRender as render } from "../runtime";
import {
  clearStoredServerUrl,
  getStoredServerUrl,
  isProductionShell,
} from "../serverConfig";
import { uiContext } from "../state";
import { escapeHtml } from "../util/html";
import { bootstrapSession } from "./session";
import { polishNativeControls } from "./shell";

// Смена сервера: стираем токены и сохранённый адрес, после перезагрузки
// показывается экран «Подключение к серверу». Вызывается с экрана входа,
// экрана «Сервер недоступен» и вкладки настроек «Сервер».
export async function switchServer(): Promise<void> {
  const ok = await confirmDialog({
    title: "Сменить сервер",
    body: "Отключиться от текущего сервера и ввести новый адрес? Локальные токены будут удалены.",
    confirmLabel: "Сменить",
    danger: true,
  });
  if (!ok) return;
  await uiContext.httpClient.logout();
  clearStoredServerUrl();
  window.location.reload();
}

// Узнаём без авторизации, открыта ли регистрация, чтобы не показывать вкладку,
// которая вернёт 403. Старый сервер без этой ручки или нет связи: ничего не
// меняем, вкладка остаётся.
export async function loadPublicConfig(): Promise<void> {
  try {
    const cfg = await uiContext.httpClient.request<{
      registrationOpen: boolean;
    }>("GET", "/api/v1/server/public-config", undefined, { auth: false });
    if (
      typeof cfg?.registrationOpen !== "boolean" ||
      uiContext.state.registrationOpen === cfg.registrationOpen
    )
      return;
    const previous = uiContext.state.registrationOpen;
    uiContext.state.registrationOpen = cfg.registrationOpen;
    // Перерисовка формы входа стирает набранные логин и пароль, поэтому её
    // делаем, только когда вид действительно меняется: вкладка «Регистрация»
    // появляется или исчезает.
    const tabVisibilityChanged =
      cfg.registrationOpen === false || previous === false;
    if (tabVisibilityChanged && !uiContext.httpClient.getTokens()) render();
  } catch {
    /* не критично */
  }
}

// Принудительная смена временного пароля. Пока админ-выданный пароль не заменён,
// сервер отвечает 403 password_change_required на всё, кроме смены пароля,
// /users/me и выхода, поэтому интерфейс показывает только эту форму.
export function renderForcedPasswordChange(): void {
  const username = uiContext.state.me?.username ?? "";
  uiContext.rootEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Смена пароля</h1>
        <p class="onboarding-hint">
          Администратор выдал тебе временный пароль. Задай свой, чтобы продолжить.
        </p>
        <form id="forced-password-form" class="auth-form">
          <label>Временный пароль
            <input name="current" type="password" autocomplete="current-password" required />
          </label>
          <label>Новый пароль
            <input name="next" type="password" autocomplete="new-password" required minlength="8" />
          </label>
          <label>Повтори новый пароль
            <input name="repeat" type="password" autocomplete="new-password" required minlength="8" />
          </label>
          <div class="auth-error" id="forced-password-error" role="alert" aria-live="polite" hidden></div>
          <button type="submit" class="primary" id="forced-password-submit">Сохранить пароль</button>
        </form>
        <div class="auth-server-strip">
          <span>Вход выполнен как <code>${escapeHtml(username)}</code></span>
          <button type="button" class="ghost" id="forced-password-logout">Выйти</button>
        </div>
      </div>
    </div>
  `;
  const form = uiContext.rootEl.querySelector<HTMLFormElement>(
    "#forced-password-form",
  );
  const errorEl = uiContext.rootEl.querySelector<HTMLDivElement>(
    "#forced-password-error",
  );
  const submit = uiContext.rootEl.querySelector<HTMLButtonElement>(
    "#forced-password-submit",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#forced-password-logout")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#forced-password-logout",
        ),
        "click",
        () => {
          void uiContext.httpClient.logout();
        },
        "bind-122444",
      )
    : undefined;
  form
    ? bindEvent(
        form,
        "submit",
        async (event) => {
          event.preventDefault();
          if (!errorEl || !submit) return;
          const data = new FormData(form);
          const current = String(data.get("current") ?? "");
          const next = String(data.get("next") ?? "");
          const repeat = String(data.get("repeat") ?? "");
          // Ошибки показываются на месте, без render(): иначе введённые поля сотрутся.
          const fail = (message: string): void => {
            errorEl.textContent = message;
            errorEl.hidden = false;
            submit.disabled = false;
          };
          if (next.length < 8)
            return fail("Новый пароль должен быть не короче 8 знаков");
          if (next !== repeat) return fail("Пароли не совпадают");
          if (next === current)
            return fail("Новый пароль должен отличаться от временного");
          errorEl.hidden = true;
          submit.disabled = true;
          try {
            await uiContext.httpClient.post("/api/v1/users/me/password", {
              currentPassword: current,
              newPassword: next,
            });
            if (uiContext.state.me)
              uiContext.state.me.mustChangePassword = false;
            await bootstrapSession();
          } catch (err) {
            fail(describeForcedPasswordError(err));
          }
        },
        "bind-122584",
      )
    : undefined;
}

export function describeForcedPasswordError(err: unknown): string {
  const api = err as ApiError | null;
  // Неверный временный пароль сервер сообщает кодом 403 authorization_denied.
  if (
    api &&
    typeof api === "object" &&
    api.status === 403 &&
    api.code === "authorization_denied"
  ) {
    return "Временный пароль введён неверно";
  }
  return describeError(err);
}

// Экран «Сервер недоступен»: токены целы, пользователь не разлогинен.
export function renderConnectionLost(): void {
  const serverUrl = getStoredServerUrl() ?? uiContext.httpClient.baseUrl;
  uiContext.rootEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Сервер недоступен</h1>
        <p class="onboarding-hint">
          Не удалось связаться с сервером${serverUrl ? ` <code>${escapeHtml(serverUrl)}</code>` : ""}.
          Ты не вышел из аккаунта: как только связь вернётся, нажми «Повторить».
        </p>
        <div class="auth-error" role="alert">${escapeHtml(uiContext.state.bootError ?? "")}</div>
        <div class="connection-lost-actions">
          <button type="button" class="primary" id="connection-retry">Повторить</button>
          ${isProductionShell() ? `<button type="button" class="ghost" id="connection-switch">Сменить сервер</button>` : ""}
        </div>
      </div>
    </div>
  `;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#connection-retry")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#connection-retry"),
        "click",
        () => {
          uiContext.state.bootError = null;
          void bootstrapSession();
        },
        "bind-124984",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#connection-switch")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#connection-switch"),
        "click",
        () => {
          void switchServer();
        },
        "bind-125145",
      )
    : undefined;
}

export function renderAuth(): void {
  uiContext.rootEl.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card">
        <h1>Cirvo</h1>
        ${
          uiContext.state.registrationOpen === false
            ? `
          <p class="onboarding-hint auth-closed-note">
            Регистрация на этом сервере закрыта. Попроси администратора создать для тебя аккаунт.
          </p>
        `
            : `
          <div class="auth-tabs">
            <button data-tab="login" class="auth-tab active">Войти</button>
            <button data-tab="register" class="auth-tab">Регистрация</button>
          </div>
        `
        }
        <form id="auth-form" class="auth-form" data-mode="login">
          <label data-only="login">Логин или email
            <input name="login" autocomplete="username" />
          </label>
          <label data-only="register">Email
            <input name="email" type="email" autocomplete="email" />
          </label>
          <label data-only="register">Имя пользователя
            <input name="username" minlength="3" maxlength="32" data-tooltip="строчные a-z, 0-9, нижнее подчёркивание; 3-32 символа" placeholder="username" />
          </label>
          <label data-only="register">Отображаемое имя
            <input name="displayName" />
          </label>
          <label>Пароль
            <input name="password" type="password" autocomplete="current-password" required minlength="8" />
          </label>
          ${uiContext.state.authError ? `<div class="auth-error">${escapeHtml(uiContext.state.authError)}</div>` : ""}
          <button type="submit" class="primary">Продолжить</button>
        </form>
        ${
          isProductionShell() && getStoredServerUrl()
            ? `
          <div class="auth-server-strip">
            <span>Сервер: <code>${escapeHtml(getStoredServerUrl() ?? "")}</code></span>
            <button type="button" class="ghost auth-switch-server">Сменить</button>
          </div>
        `
            : ""
        }
      </div>
    </div>
  `;
  polishNativeControls(uiContext.rootEl);
  uiContext.rootEl.querySelector<HTMLButtonElement>(".auth-switch-server")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          ".auth-switch-server",
        ),
        "click",
        () => {
          void switchServer();
        },
        "bind-127236",
      )
    : undefined;
  const form = uiContext.rootEl.querySelector<HTMLFormElement>("#auth-form");
  const tabs =
    uiContext.rootEl.querySelectorAll<HTMLButtonElement>(".auth-tab");
  if (!form) return;
  updateAuthVisibility(form, "login");
  tabs.forEach((tab) => {
    bindEvent(
      tab,
      "click",
      (e) => {
        e.preventDefault();
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        updateAuthVisibility(
          form,
          tab.dataset.tab === "register" ? "register" : "login",
        );
      },
      "bind-127595",
    );
  });
  bindEvent(
    form,
    "submit",
    async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const mode = form.dataset.mode === "register" ? "register" : "login";
      uiContext.state.authError = null;
      try {
        if (mode === "register") {
          const rawUsername = String(data.get("username") ?? "")
            .trim()
            .toLowerCase();
          const username = rawUsername.replace(/[^a-z0-9_]/g, "_");
          if (!/^[a-z0-9_]{3,32}$/.test(username)) {
            uiContext.state.authError =
              "Имя пользователя: 3–32 символа, только a–z, 0–9, _";
            render();
            return;
          }
          await uiContext.httpClient.register({
            email: String(data.get("email") ?? "").trim(),
            username,
            password: String(data.get("password") ?? ""),
            displayName:
              String(data.get("displayName") ?? "").trim() || undefined,
          });
        } else {
          await uiContext.httpClient.login(
            String(data.get("login") ?? "").trim(),
            String(data.get("password") ?? ""),
          );
        }
        await bootstrapSession();
      } catch (err) {
        uiContext.state.authError = describeError(err);
        render();
      }
    },
    "bind-127857",
  );
}

export function updateAuthVisibility(
  form: HTMLFormElement,
  mode: "login" | "register",
): void {
  form.dataset.mode = mode;
  form.querySelectorAll<HTMLElement>("[data-only]").forEach((el) => {
    const onlyFor = el.dataset.only;
    const isVisible = onlyFor === mode;
    el.style.display = isVisible ? "" : "none";
    el.querySelectorAll<HTMLInputElement>("input").forEach((input) => {
      input.disabled = !isVisible;
      if (
        input.name === "email" ||
        input.name === "username" ||
        input.name === "login"
      ) {
        input.required = isVisible;
      }
    });
  });
}
