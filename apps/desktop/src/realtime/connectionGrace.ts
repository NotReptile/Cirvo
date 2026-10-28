import type { ConnectionState } from "./realtimeClient";

// Плашка «Соединение потеряно» показывается только если обрыв длится дольше
// graceMs. Короткие переподключения (доли секунды) пользователь не видит.
export const CONNECTION_BANNER_GRACE_MS = 4000;

export interface ConnectionGate {
  push(state: ConnectionState): void;
  dispose(): void;
}

// Превращает поток состояний соединения в булев «показывать плашку».
// onChange вызывается только при смене значения.
export function createConnectionGate(
  onChange: (visible: boolean) => void,
  graceMs: number = CONNECTION_BANNER_GRACE_MS,
): ConnectionGate {
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const set = (next: boolean) => {
    if (visible === next) return;
    visible = next;
    onChange(next);
  };
  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    push(state) {
      if (state === "reconnecting") {
        if (!visible && !timer) {
          timer = setTimeout(() => {
            timer = null;
            set(true);
          }, graceMs);
        }
        return;
      }
      clear();
      set(false);
    },
    dispose: clear,
  };
}
