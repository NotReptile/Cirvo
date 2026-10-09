export interface LayoutMessage {
  id: string;
  authorId: string;
  createdAt: string;
  kind?: string;
  replyTo?: unknown;
}
export interface MessageLayout {
  id: string;
  index: number;
  day: boolean;
  unread: boolean;
  grouped: boolean;
}
export interface LayoutOptions {
  meId?: string;
  lastReadAt?: string | null;
  editingId?: string | null;
  groupMessages: boolean;
  start?: number;
  end?: number;
}

function dayKey(value: string): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function layoutMessages(
  messages: readonly LayoutMessage[],
  options: LayoutOptions,
): MessageLayout[] {
  const start = options.start ?? 0,
    end = Math.min(messages.length, options.end ?? messages.length);
  const cutoff = options.lastReadAt ? Date.parse(options.lastReadAt) : NaN;
  // This predicate is independent of the DOM window, so the divider remains unique.
  const unreadIndex = Number.isNaN(cutoff)
    ? -1
    : messages.findIndex(
        (m) => Date.parse(m.createdAt) > cutoff && m.authorId !== options.meId,
      );
  const result: MessageLayout[] = [];
  for (let index = start; index < end; index++) {
    const message = messages[index],
      previous = messages[index - 1];
    const day =
      !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
    const unread = index === unreadIndex;
    const grouped =
      options.groupMessages &&
      !!previous &&
      !day &&
      !unread &&
      (!message.kind || message.kind === "user") &&
      (!previous.kind || previous.kind === "user") &&
      previous.authorId === message.authorId &&
      !message.replyTo &&
      options.editingId !== message.id &&
      Date.parse(message.createdAt) - Date.parse(previous.createdAt) <
        7 * 60_000;
    result.push({ id: message.id, index, day, unread, grouped });
  }
  return result;
}

export const MESSAGE_WINDOW_SIZE = 200;
export function messageWindow(
  length: number,
  requestedStart: number | null,
): { start: number; end: number } {
  const maxStart = Math.max(0, length - MESSAGE_WINDOW_SIZE);
  const start =
    requestedStart === null
      ? maxStart
      : Math.max(0, Math.min(maxStart, requestedStart));
  return { start, end: Math.min(length, start + MESSAGE_WINDOW_SIZE) };
}
