import { confirmDialog } from "../dialogs";
import { bindEvent, delegate } from "../dom";
import { describeError } from "../errors";
import type { Locale, TimeFormat } from "../i18n";
import { setLocale, setTimeFormat, t } from "../i18n";
import { icon } from "../icons";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import type {
  Me,
  ProfileFieldOpts,
  ProfileStyleDraft,
  ProfileWidget,
  SettingsTab,
} from "../types";
import { escapeHtml } from "../util/html";
import { findSettingsTab, settingsSearchIndex } from "./activity";
import { parseGradient } from "./callView";
import { setTransientStatus } from "./helpers";
import { renderBody } from "./messageView";
import { widgetIcon } from "./profile";
import { attachSettingsAppearanceHandlers } from "./settingsAppearance";
import { attachSettingsHotkeysHandlers } from "./settingsHotkeys";
import { attachSettingsNotificationsHandlers } from "./settingsNotifications";
import { attachSettingsPrivacyHandlers } from "./settingsPrivacy";
import { attachSettingsServerHandlers } from "./settingsServer";
import { renderAvatar } from "./shell";
import {
  attachSettingsVoiceHandlers,
  stopVoiceTestsIfNotActive,
} from "./voiceSettings";

export function renderSettingsProfileTab(): string {
  const me = uiContext.state.me;
  if (!me) return "";
  const editing = uiContext.state.profileEdit.field;
  const pe = uiContext.state.profileEdit;
  // I.6(b): live-preview — при editing подменяем поле в profile-card-head
  // на текущий draft. Юзер сразу видит как профиль будет выглядеть
  // для других, не уходя из настроек.
  const previewDisplayName =
    editing === "displayName" && pe.draftDisplayName.trim()
      ? pe.draftDisplayName.trim()
      : me.displayName || me.username;
  const previewBio = editing === "bio" ? pe.draftBio : (me.bio ?? "");
  const previewBannerColor =
    editing === "bannerColor" ? pe.draftBannerColor : (me.bannerColor ?? "");
  // I.6: баннер — либо image (banner_media_id), либо solid-цвет
  // (banner_color), либо дефолтный gradient. data-banner-media для
  // lazy-load (тот же mediaBlobCache, что для аватаров). Если редактируем
  // bannerColor — игнорим banner_media_id и показываем live solid-цвет.
  const useMedia = me.bannerMediaId && editing !== "bannerColor";
  const bannerStyle = useMedia
    ? "" // image приедет через data-banner-media
    : previewBannerColor
      ? `background: ${escapeHtml(previewBannerColor)};`
      : "";
  const bannerAttrs = useMedia
    ? ` data-banner-media="${escapeHtml(me.bannerMediaId)}"`
    : "";
  return `
    <div class="profile-card-head">
      <div class="profile-banner-area" style="${bannerStyle}"${bannerAttrs}>
        <div class="profile-banner-actions">
          <button id="profile-banner-upload" class="ghost profile-banner-btn" data-tooltip="${t("pf.banner.upload")}">
            ${icon("pencil", { size: 14 })}
          </button>
          ${
            me.bannerMediaId
              ? `<button id="profile-banner-remove" class="ghost profile-banner-btn" data-tooltip="${t("pf.banner.remove")}">${icon("trash", { size: 14 })}</button>`
              : ""
          }
        </div>
      </div>
      <input id="profile-banner-input" type="file" accept="image/*" hidden />
      <div class="profile-card-avatar-wrap">
        ${renderAvatar({
          avatarMediaId: me.avatarMediaId,
          fallbackText: previewDisplayName,
          sizePx: 96,
          className: "profile-card-avatar",
          decoration: uiContext.profileStyleDraft
            ? uiContext.profileStyleDraft.decoration || undefined
            : me.avatarDecoration,
        })}
        <button id="profile-avatar-upload" class="profile-card-avatar-edit" data-tooltip="${t("pf.avatar.change")}">
          ${icon("pencil", { size: 14 })}
        </button>
        ${
          me.avatarMediaId
            ? `<button id="profile-avatar-remove" class="profile-card-avatar-remove" data-tooltip="${t("pf.avatar.remove")}">${icon("trash", { size: 12 })}</button>`
            : ""
        }
      </div>
      <div class="profile-card-name">
        <div class="profile-card-display">${escapeHtml(previewDisplayName)}</div>
        <div class="profile-card-username">@${escapeHtml(me.username)}</div>
      </div>
      ${
        previewBio
          ? `<div class="profile-card-bio-preview">${renderBody(previewBio)}</div>`
          : ""
      }
    </div>
    <div class="profile-card-fields">
      ${renderProfileField({
        label: t("pf.displayname"),
        value: me.displayName || "—",
        field: "displayName",
        editing: editing === "displayName",
        body: renderProfileEditDisplayName(me.displayName ?? ""),
      })}
      ${renderProfileField({
        label: t("pf.bio"),
        value: me.bio || "—",
        field: "bio",
        editing: editing === "bio",
        body: renderProfileEditBio(),
      })}
      ${renderProfileField({
        label: t("pf.bannercolor"),
        value: me.bannerColor || t("ap.accent.default"),
        field: "bannerColor",
        editing: editing === "bannerColor",
        body: renderProfileEditBannerColor(),
      })}
      ${renderProfileField({
        label: t("pf.username"),
        value: "@" + me.username,
        field: "username",
        editing: false,
        disabled: true,
        disabledHint: t("pf.username.hint"),
        body: "",
      })}
      ${renderProfileField({
        label: t("pf.email"),
        value: me.email,
        field: "email",
        editing: false,
        disabled: true,
        disabledHint: t("pf.email.hint"),
        body: "",
      })}
      ${renderProfileField({
        label: t("pf.password"),
        value: "••••••••",
        field: "password",
        editing: editing === "password",
        body: renderProfileEditPassword(),
      })}
    </div>
    ${renderProfileStyleSection(me, previewDisplayName)}
    ${renderProfileWidgetsSection()}
  `;
}

export function renderProfileWidgetsSection(): string {
  const rows =
    uiContext.widgetsDraft === null
      ? `<div class="settings-hint">${t("common.loading")}</div>`
      : uiContext.widgetsDraft.length === 0
        ? `<div class="settings-hint" style="margin:8px 0">${t("pw.empty")}</div>`
        : uiContext.widgetsDraft
            .map(
              (w, i) => `
          <div class="widget-edit-row">
            <span class="profile-widget-icon">${widgetIcon(w.url)}</span>
            <input type="text" maxlength="48" placeholder="${t("pw.name.ph")}" value="${escapeHtml(w.label)}" data-widget-label="${i}" class="widget-edit-label" />
            <input type="text" maxlength="300" placeholder="https://…" value="${escapeHtml(w.url)}" data-widget-url="${i}" class="widget-edit-url" />
            <button class="ghost" data-widget-up="${i}" data-tooltip="${t("pw.up")}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="ghost" data-widget-down="${i}" data-tooltip="${t("pw.down")}" ${i === (uiContext.widgetsDraft?.length ?? 0) - 1 ? "disabled" : ""}>↓</button>
            <button class="ghost danger" data-widget-remove="${i}" data-tooltip="${t("common.delete")}">✕</button>
          </div>
        `,
            )
            .join("");
  const canAdd = (uiContext.widgetsDraft?.length ?? 0) < 8;
  return `
    <div class="settings-section profile-widgets-section">
      <h3>${t("pw.title")}</h3>
      <small class="settings-hint">
        ${t("pw.hint")}
      </small>
      ${rows}
      <div class="admin-actions">
        ${canAdd && uiContext.widgetsDraft !== null ? `<button id="pw-add" class="ghost">${t("pw.add")}</button>` : ""}
        ${uiContext.widgetsDraft !== null ? `<button id="pw-save" class="primary" ${uiContext.widgetsSaving ? "disabled" : ""}>${uiContext.widgetsSaving ? t("common.saving") : t("pw.save")}</button>` : ""}
      </div>
    </div>
  `;
}

export async function loadMyWidgets(): Promise<void> {
  if (uiContext.widgetsLoading || !uiContext.state.me) return;
  uiContext.widgetsLoading = true;
  try {
    const data = await uiContext.httpClient.get<{ items: ProfileWidget[] }>(
      `/api/v1/users/${uiContext.state.me.id}/widgets`,
    );
    uiContext.widgetsDraft = data.items ?? [];
  } catch {
    uiContext.widgetsDraft = [];
  } finally {
    uiContext.widgetsLoading = false;
    render();
  }
}

export async function saveMyWidgets(): Promise<void> {
  if (!uiContext.widgetsDraft) return;
  // Пустые строки молча выкидываем — юзер добавил ряд и передумал.
  const cleaned = uiContext.widgetsDraft.filter(
    (w) => w.label.trim() !== "" || w.url.trim() !== "",
  );
  uiContext.widgetsSaving = true;
  render();
  try {
    const data = await uiContext.httpClient.put<{ items: ProfileWidget[] }>(
      "/api/v1/users/me/widgets",
      {
        widgets: cleaned.map((w) => ({
          kind: w.kind,
          label: w.label.trim(),
          url: w.url.trim(),
        })),
      },
    );
    uiContext.widgetsDraft = data.items ?? [];
    setTransientStatus("Виджеты сохранены");
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.widgetsSaving = false;
    render();
  }
}

export function styleDraftFromMe(me: Me): ProfileStyleDraft {
  const theme = parseGradient(me.profileTheme);
  const grad = parseGradient(me.nameGradient);
  return {
    themeOn: !!theme,
    themeA: theme?.[0] ?? "#1e1f22",
    themeB: theme?.[1] ?? "#5865f2",
    gradOn: !!grad,
    gradA: grad?.[0] ?? "#5865f2",
    gradB: grad?.[1] ?? "#eb459e",
    badgeEmoji: me.badgeEmoji ?? "",
    badgeLabel: me.badgeLabel ?? "",
    decoration: me.avatarDecoration ?? "",
    effect: me.profileEffect ?? "",
  };
}

export function ensureStyleDraft(): ProfileStyleDraft {
  if (!uiContext.profileStyleDraft && uiContext.state.me)
    uiContext.profileStyleDraft = styleDraftFromMe(uiContext.state.me);
  return (
    uiContext.profileStyleDraft ??
    styleDraftFromMe({ badgeEmoji: "", badgeLabel: "" } as Me)
  );
}

export function renderProfileStyleSection(me: Me, previewName: string): string {
  const sd = uiContext.profileStyleDraft ?? styleDraftFromMe(me);
  const gradPreviewStyle = sd.gradOn
    ? ` style="background:linear-gradient(90deg,${escapeHtml(sd.gradA)},${escapeHtml(sd.gradB)});-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:600;"`
    : ` style="font-weight:600;"`;
  return `
    <div class="settings-section profile-style-section">
      <h3>${t("ps.title")}</h3>
      <small class="settings-hint">
        ${t("ps.hint")}
      </small>
      <div class="profile-style-row">
        <label class="settings-check">
          <input type="checkbox" id="ps-theme-on" ${sd.themeOn ? "checked" : ""} />
          <span>${t("ps.theme")}</span>
        </label>
        <input type="color" id="ps-theme-a" value="${escapeHtml(sd.themeA)}" ${sd.themeOn ? "" : "disabled"} />
        <input type="color" id="ps-theme-b" value="${escapeHtml(sd.themeB)}" ${sd.themeOn ? "" : "disabled"} />
      </div>
      <div class="profile-style-row">
        <label class="settings-check">
          <input type="checkbox" id="ps-grad-on" ${sd.gradOn ? "checked" : ""} />
          <span>${t("ps.grad")}</span>
        </label>
        <input type="color" id="ps-grad-a" value="${escapeHtml(sd.gradA)}" ${sd.gradOn ? "" : "disabled"} />
        <input type="color" id="ps-grad-b" value="${escapeHtml(sd.gradB)}" ${sd.gradOn ? "" : "disabled"} />
        <span id="ps-grad-preview" class="profile-style-preview"${gradPreviewStyle}>${escapeHtml(previewName)}</span>
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.badge")}</span>
        <input type="text" id="ps-badge-emoji" maxlength="8" placeholder="🦄" value="${escapeHtml(sd.badgeEmoji)}" class="profile-style-emoji" />
        <input type="text" id="ps-badge-label" maxlength="48" placeholder="${t("ps.badge.label.ph")}" value="${escapeHtml(sd.badgeLabel)}" class="profile-style-badge-label" />
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.deco")}</span>
        <select id="ps-decoration" class="perm-select">
          <option value="">${t("ps.deco.none")}</option>
          ${uiContext.AVATAR_DECORATIONS.map((d) => `<option value="${d.id}" ${sd.decoration === d.id ? "selected" : ""}>${escapeHtml(t(`deco.${d.id}`))}</option>`).join("")}
        </select>
        <span class="profile-style-deco-preview avatar-pic${sd.decoration ? ` avatar-deco-${escapeHtml(sd.decoration)}` : ""}" style="width:28px;height:28px;font-size:13px;"><span class="avatar-letter">${escapeHtml((me.displayName || me.username || "?").charAt(0).toUpperCase())}</span></span>
      </div>
      <div class="profile-style-row">
        <span class="profile-style-label">${t("ps.fx")}</span>
        <select id="ps-effect" class="perm-select">
          <option value="">${t("ps.fx.none")}</option>
          ${uiContext.PROFILE_EFFECTS.map((e) => `<option value="${e.id}" ${sd.effect === e.id ? "selected" : ""}>${escapeHtml(t(`fx.${e.id}`))}</option>`).join("")}
        </select>
        <small class="settings-hint" style="margin:0">${t("ps.fx.hint")}</small>
      </div>
      <div class="admin-actions">
        <button id="ps-style-save" class="primary" ${uiContext.profileStyleSaving ? "disabled" : ""}>
          ${uiContext.profileStyleSaving ? t("common.saving") : t("ps.save")}
        </button>
      </div>
    </div>
  `;
}

export async function saveProfileStyle(): Promise<void> {
  const sd =
    uiContext.profileStyleDraft ??
    (uiContext.state.me ? styleDraftFromMe(uiContext.state.me) : null);
  if (!sd || !uiContext.state.me) return;
  uiContext.profileStyleSaving = true;
  render();
  try {
    const updated = await uiContext.httpClient.put<Me>("/api/v1/users/me", {
      profileTheme: sd.themeOn ? `${sd.themeA},${sd.themeB}` : "",
      nameGradient: sd.gradOn ? `${sd.gradA},${sd.gradB}` : "",
      badgeEmoji: sd.badgeEmoji.trim(),
      badgeLabel: sd.badgeLabel.trim(),
      avatarDecoration: sd.decoration,
      profileEffect: sd.effect,
    });
    uiContext.state.me = {
      ...uiContext.state.me,
      profileTheme: updated.profileTheme,
      nameGradient: updated.nameGradient,
      badgeEmoji: updated.badgeEmoji,
      badgeLabel: updated.badgeLabel,
      avatarDecoration: updated.avatarDecoration,
      profileEffect: updated.profileEffect,
    };
    // Своё имя в чате/сайдбаре рисуется из state.members — обновим локально,
    // не дожидаясь user.updated/refetch'а.
    uiContext.state.members = uiContext.state.members.map((m) =>
      m.userId === uiContext.state.me?.id
        ? {
            ...m,
            profileTheme: updated.profileTheme,
            nameGradient: updated.nameGradient,
            badgeEmoji: updated.badgeEmoji,
            badgeLabel: updated.badgeLabel,
            avatarDecoration: updated.avatarDecoration,
            profileEffect: updated.profileEffect,
          }
        : m,
    );
    uiContext.profileStyleDraft = null;
    setTransientStatus("Стиль профиля сохранён");
  } catch (err) {
    uiContext.state.status = describeError(err);
  } finally {
    uiContext.profileStyleSaving = false;
    render();
  }
}

export function renderProfileEditBio(): string {
  const pe = uiContext.state.profileEdit;
  const errBlock = pe.error
    ? `<div class="modal-error">${escapeHtml(pe.error)}</div>`
    : "";
  const remaining = 600 - pe.draftBio.length;
  return `
    <textarea id="profile-bio-input" maxlength="600" rows="4"
              placeholder="${t("pf.bio.ph")}">${escapeHtml(pe.draftBio)}</textarea>
    <div class="profile-field-hint" style="text-align:right;">${t("pf.bio.chars", { n: remaining })}</div>
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-bio-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  `;
}

export function renderProfileEditBannerColor(): string {
  const pe = uiContext.state.profileEdit;
  const errBlock = pe.error
    ? `<div class="modal-error">${escapeHtml(pe.error)}</div>`
    : "";
  const colorValue = pe.draftBannerColor || "#5865f2";
  return `
    <div class="settings-slider-wrap" style="gap:12px; align-items:center;">
      <input id="profile-banner-color-input" type="color" value="${escapeHtml(colorValue)}" />
      <span id="profile-banner-color-val" class="settings-slider-val" style="min-width:120px;">${escapeHtml(pe.draftBannerColor || t("ap.accent.default"))}</span>
      <button id="profile-banner-color-clear" class="ghost" data-tooltip="${t("pf.clear")}">${icon("x", { size: 14 })}</button>
    </div>
    <small class="profile-field-hint">${t("pf.bannercolor.hint")}</small>
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-banner-color-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  `;
}

export function attachSettingsHandlers(): void {
  // I.2: тушим mic/cam тесты как только модалка закрылась или таб сменился —
  // вызываем безусловно (не только когда modal=settings), чтобы при закрытии
  // модалки стримы освобождались.
  stopVoiceTestsIfNotActive();
  // I.10: при закрытии модалки сбрасываем sessions-кеш, чтобы следующее
  // открытие privacy-таба перетянуло актуальный список.
  if (uiContext.state.modal !== "settings") {
    uiContext._sessions = null;
    uiContext._sessionsError = null;
    uiContext.profileStyleDraft = null;
    uiContext.widgetsDraft = null;
    return;
  }
  // Wave 7 (I.13): редактор виджетов. Ленивая загрузка своих виджетов при
  // первом рендере профиль-таба.
  if (
    uiContext.state.settings.tab === "profile" &&
    uiContext.widgetsDraft === null &&
    !uiContext.widgetsLoading
  ) {
    void loadMyWidgets();
  }
  delegate<HTMLInputElement, "input">(
    uiContext.rootEl,
    "[data-widget-label]",
    "input",
    (_event, inp) => {
      const i = Number(inp.dataset.widgetLabel);
      if (uiContext.widgetsDraft?.[i])
        uiContext.widgetsDraft[i].label = inp.value;
    },
    "delegate-403966",
  );
  delegate<HTMLInputElement, "input">(
    uiContext.rootEl,
    "[data-widget-url]",
    "input",
    (_event, inp) => {
      const i = Number(inp.dataset.widgetUrl);
      if (uiContext.widgetsDraft?.[i])
        uiContext.widgetsDraft[i].url = inp.value;
    },
    "delegate-404221",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-widget-up]",
    "click",
    (_event, btn) => {
      const i = Number(btn.dataset.widgetUp);
      if (!uiContext.widgetsDraft || i <= 0) return;
      [uiContext.widgetsDraft[i - 1], uiContext.widgetsDraft[i]] = [
        uiContext.widgetsDraft[i],
        uiContext.widgetsDraft[i - 1],
      ];
      render();
    },
    "delegate-404470",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-widget-down]",
    "click",
    (_event, btn) => {
      const i = Number(btn.dataset.widgetDown);
      if (!uiContext.widgetsDraft || i >= uiContext.widgetsDraft.length - 1)
        return;
      [uiContext.widgetsDraft[i], uiContext.widgetsDraft[i + 1]] = [
        uiContext.widgetsDraft[i + 1],
        uiContext.widgetsDraft[i],
      ];
      render();
    },
    "delegate-404802",
  );
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-widget-remove]",
    "click",
    (_event, btn) => {
      const i = Number(btn.dataset.widgetRemove);
      if (!uiContext.widgetsDraft) return;
      uiContext.widgetsDraft.splice(i, 1);
      render();
    },
    "delegate-405160",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#pw-add")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#pw-add"),
        "click",
        () => {
          if (!uiContext.widgetsDraft || uiContext.widgetsDraft.length >= 8)
            return;
          uiContext.widgetsDraft.push({ kind: "link", label: "", url: "" });
          render();
        },
        "bind-405080",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#pw-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#pw-save"),
        "click",
        () => {
          void saveMyWidgets();
        },
        "bind-405308",
      )
    : undefined;
  // Wave 7: «Стиль профиля». Чекбоксы триггерят render() (надо включить/
  // выключить color-input'ы), цвета/текст пишут в draft без render(),
  // превью градиента обновляется прямым DOM-стилем.
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-on")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-on"),
        "change",
        (e) => {
          ensureStyleDraft().themeOn = (
            e.currentTarget as HTMLInputElement
          ).checked;
          render();
        },
        "bind-405627",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-on")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-on"),
        "change",
        (e) => {
          ensureStyleDraft().gradOn = (
            e.currentTarget as HTMLInputElement
          ).checked;
          render();
        },
        "bind-405821",
      )
    : undefined;
  const updateGradPreview = (): void => {
    const sd = ensureStyleDraft();
    const prev =
      uiContext.rootEl.querySelector<HTMLSpanElement>("#ps-grad-preview");
    if (!prev) return;
    if (sd.gradOn) {
      prev.style.background = `linear-gradient(90deg,${sd.gradA},${sd.gradB})`;
      prev.style.webkitBackgroundClip = "text";
      prev.style.backgroundClip = "text";
      prev.style.color = "transparent";
    }
  };
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-a")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-a"),
        "input",
        (e) => {
          ensureStyleDraft().themeA = (
            e.currentTarget as HTMLInputElement
          ).value;
        },
        "bind-406431",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-b")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-theme-b"),
        "input",
        (e) => {
          ensureStyleDraft().themeB = (
            e.currentTarget as HTMLInputElement
          ).value;
        },
        "bind-406606",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-a")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-a"),
        "input",
        (e) => {
          ensureStyleDraft().gradA = (
            e.currentTarget as HTMLInputElement
          ).value;
          updateGradPreview();
        },
        "bind-406781",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-b")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-grad-b"),
        "input",
        (e) => {
          ensureStyleDraft().gradB = (
            e.currentTarget as HTMLInputElement
          ).value;
          updateGradPreview();
        },
        "bind-406979",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-badge-emoji")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-badge-emoji"),
        "input",
        (e) => {
          ensureStyleDraft().badgeEmoji = (
            e.currentTarget as HTMLInputElement
          ).value;
        },
        "bind-407177",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#ps-badge-label")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#ps-badge-label"),
        "input",
        (e) => {
          ensureStyleDraft().badgeLabel = (
            e.currentTarget as HTMLInputElement
          ).value;
        },
        "bind-407360",
      )
    : undefined;
  // I.15–I.16: селекты рамки/эффекта. render() — чтобы обновить превью
  // рамки рядом с селектом и на большом аватаре сверху.
  uiContext.rootEl.querySelector<HTMLSelectElement>("#ps-decoration")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#ps-decoration"),
        "change",
        (e) => {
          ensureStyleDraft().decoration = (
            e.currentTarget as HTMLSelectElement
          ).value;
          render();
        },
        "bind-407672",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#ps-effect")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#ps-effect"),
        "change",
        (e) => {
          ensureStyleDraft().effect = (
            e.currentTarget as HTMLSelectElement
          ).value;
        },
        "bind-407871",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#ps-style-save")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#ps-style-save"),
        "click",
        () => {
          void saveProfileStyle();
        },
        "bind-408048",
      )
    : undefined;
  delegate<HTMLButtonElement, "click">(
    uiContext.rootEl,
    "[data-settings-tab]",
    "click",
    (_event, btn) => {
      const tab = btn.dataset.settingsTab as SettingsTab | undefined;
      if (!tab) return;
      uiContext.state.settings.tab = tab;
      uiContext.state.profileEdit.field = null;
      uiContext.state.profileEdit.error = null;
      uiContext.state.profileEdit.okMessage = null;
      render();
    },
    "delegate-408534",
  );
  uiContext.rootEl.querySelector<HTMLButtonElement>("#settings-logout-btn")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#settings-logout-btn",
        ),
        "click",
        async () => {
          const ok = await confirmDialog({
            title: "Выйти из аккаунта?",
            confirmLabel: "Выйти",
            danger: true,
          });
          if (!ok) return;
          void uiContext.httpClient.logout();
        },
        "bind-408563",
      )
    : undefined;
  attachSettingsVoiceHandlers();
  attachSettingsHotkeysHandlers();
  attachSettingsAppearanceHandlers();
  attachSettingsNotificationsHandlers();
  attachSettingsPrivacyHandlers();
  attachSettingsServerHandlers();
  attachSettingsLanguageHandlers();
  attachSettingsSearchHandler();
}

export function attachSettingsLanguageHandlers(): void {
  uiContext.rootEl.querySelector<HTMLSelectElement>("#settings-locale")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>("#settings-locale"),
        "change",
        (e) => {
          const v = (e.currentTarget as HTMLSelectElement).value as Locale;
          setLocale(v);
          render();
        },
        "bind-409193",
      )
    : undefined;
  delegate<HTMLInputElement, "change">(
    uiContext.rootEl,
    'input[name="settings-time-format"]',
    "change",
    (_event, r) => {
      if (!r.checked) return;
      setTimeFormat(r.value as TimeFormat);
      render();
    },
    "delegate-409774",
  );
}

export function attachSettingsSearchHandler(): void {
  const input =
    uiContext.rootEl.querySelector<HTMLInputElement>("#settings-search");
  const results = uiContext.rootEl.querySelector<HTMLDivElement>(
    "#settings-search-results",
  );
  if (!input || !results) return;

  // I.11(a): подсвечивает первое вхождение query в label через <mark>.
  // Регистрация query одинаковая для матчинга и highlight — обе lowercased,
  // но индекс восстанавливаем по оригинальному label, чтобы не порушить cyrillic.
  const highlightLabel = (label: string, q: string): string => {
    const idx = label.toLowerCase().indexOf(q);
    if (idx < 0) return escapeHtml(label);
    return (
      escapeHtml(label.slice(0, idx)) +
      `<mark>${escapeHtml(label.slice(idx, idx + q.length))}</mark>` +
      escapeHtml(label.slice(idx + q.length))
    );
  };

  // I.11(b): индекс выделенной строки в dropdown'е. -1 = ничего не выделено.
  let activeIdx = -1;

  const updateActive = (): void => {
    const items = results.querySelectorAll<HTMLButtonElement>(
      ".settings-search-item",
    );
    items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
    if (activeIdx >= 0 && items[activeIdx]) {
      items[activeIdx].scrollIntoView({ block: "nearest" });
    }
  };

  const renderResults = (): void => {
    const q = input.value.trim().toLowerCase();
    uiContext.state.settings.search = input.value;
    activeIdx = -1;
    if (q.length < 2) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const matches = settingsSearchIndex().filter((e) => {
      const hay = (e.label + " " + (e.keywords ?? []).join(" ")).toLowerCase();
      return hay.includes(q);
    });
    if (matches.length === 0) {
      results.hidden = false;
      results.innerHTML = `<div class="settings-search-empty">${t("search.none")}</div>`;
      return;
    }
    results.hidden = false;
    results.innerHTML = matches
      .map((m) => {
        const tabLabel = findSettingsTab(m.tab).label;
        return `
          <button class="settings-search-item"
                  data-search-tab="${m.tab}"
                  data-search-anchor="${escapeHtml(m.label)}">
            <span class="settings-search-item-label">${highlightLabel(m.label, q)}</span>
            <span class="settings-search-item-tab">${escapeHtml(tabLabel)}</span>
          </button>
        `;
      })
      .join("");
    // Первая строка выделена по умолчанию — Enter сразу её выберет.
    activeIdx = 0;
    updateActive();
  };

  const selectActive = (): void => {
    const items = results.querySelectorAll<HTMLButtonElement>(
      ".settings-search-item",
    );
    const btn = activeIdx >= 0 ? items[activeIdx] : items[0];
    btn?.click();
  };

  bindEvent(input, "input", renderResults, "bind-412574");
  bindEvent(input, "focus", renderResults, "bind-412624");
  // setTimeout — даём click по результату сработать до того как dropdown скроется.
  bindEvent(
    input,
    "blur",
    () => {
      setTimeout(() => {
        results.hidden = true;
      }, 150);
    },
    "bind-412758",
  );
  bindEvent(
    input,
    "keydown",
    (e) => {
      if (e.key === "Escape") {
        input.value = "";
        uiContext.state.settings.search = "";
        results.hidden = true;
        results.innerHTML = "";
        input.blur();
        return;
      }
      const items = results.querySelectorAll<HTMLButtonElement>(
        ".settings-search-item",
      );
      if (items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % items.length;
        updateActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + items.length) % items.length;
        updateActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectActive();
      }
    },
    "bind-412870",
  );

  bindEvent(
    results,
    "click",
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-search-tab]",
      );
      if (!btn) return;
      const tab = btn.dataset.searchTab as SettingsTab | undefined;
      const anchor = btn.dataset.searchAnchor ?? "";
      if (!tab) return;
      uiContext.state.settings.tab = tab;
      uiContext.state.settings.search = "";
      uiContext._pendingSearchScroll = anchor;
      uiContext.state.profileEdit.field = null;
      uiContext.state.profileEdit.error = null;
      uiContext.state.profileEdit.okMessage = null;
      render();
    },
    "bind-413605",
  );

  if (uiContext._pendingSearchScroll) {
    const anchor = uiContext._pendingSearchScroll;
    uiContext._pendingSearchScroll = null;
    requestAnimationFrame(() => {
      const body = uiContext.rootEl.querySelector<HTMLDivElement>(
        ".settings-content-body",
      );
      if (!body) return;
      const target = Array.from(body.querySelectorAll("h3")).find(
        (h) => h.textContent?.trim() === anchor,
      );
      if (!target) return;
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.classList.add("settings-anchor-flash");
      setTimeout(() => target.classList.remove("settings-anchor-flash"), 1500);
    });
  }
}

export function renderProfileField(opts: ProfileFieldOpts): string {
  if (opts.editing) {
    return `
      <div class="profile-field profile-field-editing" data-profile-field="${opts.field}">
        <div class="profile-field-label">${escapeHtml(opts.label)}</div>
        ${opts.body}
      </div>
    `;
  }
  const action = opts.disabled
    ? `<span class="profile-field-disabled" data-tooltip="${escapeHtml(opts.disabledHint ?? "")}">${t("pf.na")}</span>`
    : `<button class="ghost profile-field-edit" data-profile-edit="${opts.field}">${t("pf.edit")}</button>`;
  return `
    <div class="profile-field" data-profile-field="${opts.field}">
      <div class="profile-field-info">
        <div class="profile-field-label">${escapeHtml(opts.label)}</div>
        <div class="profile-field-value${opts.disabled ? " is-disabled" : ""}">${escapeHtml(opts.value)}</div>
        ${opts.disabled && opts.disabledHint ? `<div class="profile-field-hint">${escapeHtml(opts.disabledHint)}</div>` : ""}
      </div>
      ${action}
    </div>
  `;
}

export function renderProfileEditDisplayName(currentValue: string): string {
  const pe = uiContext.state.profileEdit;
  const errBlock = pe.error
    ? `<div class="modal-error">${escapeHtml(pe.error)}</div>`
    : "";
  return `
    <input id="profile-display-input" type="text" maxlength="64"
           placeholder="${escapeHtml(currentValue || t("pf.displayname.ph"))}"
           value="${escapeHtml(pe.draftDisplayName)}" />
    ${errBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-display-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("common.save")}
      </button>
    </div>
  `;
}

export function renderProfileEditPassword(): string {
  const pe = uiContext.state.profileEdit;
  const errBlock = pe.error
    ? `<div class="modal-error">${escapeHtml(pe.error)}</div>`
    : "";
  const okBlock = pe.okMessage
    ? `<div class="profile-field-ok">${escapeHtml(pe.okMessage)}</div>`
    : "";
  return `
    <div class="profile-pw-grid">
      <label>
        <span class="profile-pw-label">${t("pf.pw.current")}</span>
        <input id="profile-pw-current" type="password" autocomplete="current-password" value="${escapeHtml(pe.currentPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">${t("pf.pw.new")}</span>
        <input id="profile-pw-new" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.newPassword)}" />
      </label>
      <label>
        <span class="profile-pw-label">${t("pf.pw.confirm")}</span>
        <input id="profile-pw-confirm" type="password" autocomplete="new-password" minlength="8" value="${escapeHtml(pe.confirmPassword)}" />
      </label>
    </div>
    ${errBlock}
    ${okBlock}
    <div class="profile-field-actions">
      <button class="ghost" data-profile-cancel>${t("common.cancel")}</button>
      <button id="profile-pw-save" class="primary" ${pe.saving ? "disabled" : ""}>
        ${pe.saving ? t("common.saving") : t("pf.pw.save")}
      </button>
    </div>
  `;
}
