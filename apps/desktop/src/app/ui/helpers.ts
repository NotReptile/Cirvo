import { requestRender as render } from "../runtime";
import { uiContext } from "../state";

export function armStatusAutoClear(): void {
  if (uiContext.state.status === uiContext._lastTimedStatus) return;
  uiContext._lastTimedStatus = uiContext.state.status;
  if (uiContext._statusTimer) {
    clearTimeout(uiContext._statusTimer);
    uiContext._statusTimer = null;
  }
  if (!uiContext.state.status) return;
  const msg = uiContext.state.status;
  uiContext._statusTimer = setTimeout(() => {
    uiContext._statusTimer = null;
    if (uiContext.state.status === msg) {
      uiContext.state.status = "";
      uiContext._lastTimedStatus = "";
      render(new Set(["status"]));
    }
  }, uiContext.STATUS_AUTO_CLEAR_MS);
}

export function setTransientStatus(msg: string): void {
  uiContext.state.status = msg;
  render(new Set(["status"]));
}

export function loadDraft(channelId: string | null | undefined): string {
  if (!channelId) return "";
  try {
    return localStorage.getItem(uiContext.DRAFT_KEY_PREFIX + channelId) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(
  channelId: string | null | undefined,
  value: string,
): void {
  if (!channelId) return;
  try {
    if (value)
      localStorage.setItem(uiContext.DRAFT_KEY_PREFIX + channelId, value);
    else localStorage.removeItem(uiContext.DRAFT_KEY_PREFIX + channelId);
  } catch {}
}
