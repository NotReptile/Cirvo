import { bindEvent } from "../dom";
import { requestRender as render } from "../runtime";
import { uiContext } from "../state";
import { exportAuditCsv, exportAuditCsvFromServer } from "./activity";
import { loadAudit, loadMembers } from "./loaders";

export function attachAuditRegion(): void {
  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-members")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-members"),
        "click",
        async () => {
          uiContext.state.modal = "members";
          render();
          await loadMembers();
        },
        "bind-431914",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLSelectElement>("#audit-filter-action")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>(
          "#audit-filter-action",
        ),
        "change",
        (ev) => {
          uiContext.state.auditFilter.action = (
            ev.currentTarget as HTMLSelectElement
          ).value;
          render();
        },
        "bind-432089",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLSelectElement>("#audit-filter-target")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLSelectElement>(
          "#audit-filter-target",
        ),
        "change",
        (ev) => {
          uiContext.state.auditFilter.targetType = (
            ev.currentTarget as HTMLSelectElement
          ).value;
          render();
        },
        "bind-432291",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-actor")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-actor"),
        "input",
        (ev) => {
          uiContext.state.auditFilter.actor = (
            ev.currentTarget as HTMLInputElement
          ).value;
          // Без render() — обновляем только список. Но фильтр живёт в state и
          // applyAuditFilter, поэтому надо ререндер. Каретку сохраняем через PRESERVED_INPUT_SELECTORS.
          render();
        },
        "bind-432497",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-from")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-from"),
        "change",
        (ev) => {
          uiContext.state.auditFilter.from = (
            ev.currentTarget as HTMLInputElement
          ).value;
          render();
        },
        "bind-432866",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-to")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLInputElement>("#audit-filter-to"),
        "change",
        (ev) => {
          uiContext.state.auditFilter.to = (
            ev.currentTarget as HTMLInputElement
          ).value;
          render();
        },
        "bind-433062",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#audit-filter-clear")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>(
          "#audit-filter-clear",
        ),
        "click",
        () => {
          uiContext.state.auditFilter = {
            action: "",
            actor: "",
            from: "",
            to: "",
            targetType: "",
          };
          render();
        },
        "bind-433254",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#audit-export-full")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#audit-export-full"),
        "click",
        () => {
          void exportAuditCsvFromServer();
        },
        "bind-433459",
      )
    : undefined;
  uiContext.rootEl.querySelector<HTMLButtonElement>("#audit-export-csv")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#audit-export-csv"),
        "click",
        () => {
          exportAuditCsv();
        },
        "bind-433601",
      )
    : undefined;

  uiContext.rootEl.querySelector<HTMLButtonElement>("#open-audit")
    ? bindEvent(
        uiContext.rootEl.querySelector<HTMLButtonElement>("#open-audit"),
        "click",
        async () => {
          uiContext.state.modal = "audit";
          uiContext.state.auditFilter = {
            action: "",
            actor: "",
            from: "",
            to: "",
            targetType: "",
          };
          render();
          // Members нужны для резолва UUID → displayName в журнале. Тянем
          // параллельно с audit-ом, не блокируем основной запрос.
          const needMembers =
            uiContext.state.members.length === 0 &&
            !uiContext.state.membersLoading;
          await Promise.all([
            loadAudit(),
            needMembers ? loadMembers() : Promise.resolve(),
          ]);
        },
        "bind-433728",
      )
    : undefined;
}
