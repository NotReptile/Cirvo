import { describeError } from "../errors";
import { messageWindow } from "../layoutMessages";
import { uiContext } from "../state";
import type { Message } from "../types";
import { setTransientStatus } from "./helpers";
import { updateMessageList } from "./messageList";

const gaps = new Set<string>();
let loadingGap: number | null = null;
let generation = 0;
const edge = (a: Message, b: Message) => `${a.id}|${b.id}`;
export function resetHistory(): void {
  gaps.clear();
  loadingGap = null;
  generation++;
}
export function removeHistoryMessage(id: string): void {
  const messages = uiContext.state.messages;
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) return;
  const before = messages[index - 1],
    removed = messages[index],
    after = messages[index + 1];
  const unknown = hasHistoryGap(index - 1) || hasHistoryGap(index);
  if (before) gaps.delete(edge(before, removed));
  if (after) gaps.delete(edge(removed, after));
  if (before && after && unknown) gaps.add(edge(before, after));
  uiContext.state.messages = messages.filter((message) => message.id !== id);
}
export function hasHistoryGap(index: number): boolean {
  const messages = uiContext.state.messages;
  return (
    index >= 0 &&
    index + 1 < messages.length &&
    gaps.has(edge(messages[index], messages[index + 1]))
  );
}
export function mergeHistory(page: Message[]): void {
  const previous = uiContext.state.messages;
  const known = new Set<string>();
  for (let i = 0; i + 1 < previous.length; i++)
    if (!hasHistoryGap(i)) known.add(edge(previous[i], previous[i + 1]));
  const ordered = page.slice().sort(compareMessages);
  for (let i = 0; i + 1 < ordered.length; i++)
    known.add(edge(ordered[i], ordered[i + 1]));
  const byId = new Map(previous.map((message) => [message.id, message]));
  for (const message of ordered) byId.set(message.id, message);
  const merged = [...byId.values()].sort(compareMessages);
  gaps.clear();
  for (let i = 0; i + 1 < merged.length; i++)
    if (!known.has(edge(merged[i], merged[i + 1])))
      gaps.add(edge(merged[i], merged[i + 1]));
  uiContext.state.messages = merged;
}
export function compareMessages(a: Message, b: Message): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}
export function visibleRange(): { start: number; end: number } {
  const messages = uiContext.state.messages;
  const requested = uiContext.state.windowStart;
  let start =
    requested === null
      ? messageWindow(messages.length, null).start
      : Math.max(0, Math.min(messages.length - 1, requested));
  if (requested === null)
    for (let i = start; i + 1 < messages.length; i++)
      if (hasHistoryGap(i)) start = i + 1;
  const range = { start, end: Math.min(messages.length, start + 200) };
  // A jump may load an isolated page. Never render unknown history as adjacent messages.
  for (let i = range.start; i + 1 < range.end; i++)
    if (hasHistoryGap(i)) {
      range.end = i + 1;
      break;
    }
  return range;
}
export function focusHistory(index: number): void {
  let start = Math.max(0, index - 100);
  for (let i = index - 1; i >= start; i--)
    if (hasHistoryGap(i)) {
      start = i + 1;
      break;
    }
  uiContext.state.windowStart = start;
}
export async function loadHistoryGap(
  direction: "before" | "after",
  anchor: Message,
): Promise<void> {
  if (loadingGap !== null || !uiContext.state.selectedChannelId) return;
  const requestGeneration = generation;
  loadingGap = requestGeneration;
  const channelId = uiContext.state.selectedChannelId;
  const cursor = `${anchor.createdAt}|${anchor.id}`;
  try {
    const page = await uiContext.httpClient.get<{ items: Message[] }>(
      `/api/v1/channels/${channelId}/messages?limit=100&${direction}=${encodeURIComponent(cursor)}`,
    );
    if (
      uiContext.state.selectedChannelId !== channelId ||
      requestGeneration !== generation
    )
      return;
    // Include the anchor to record its connection with this page.
    mergeHistory([anchor, ...(page.items ?? [])]);
    const index = uiContext.state.messages.findIndex(
      (message) => message.id === anchor.id,
    );
    focusHistory(index);
    updateMessageList();
  } catch (error) {
    if (requestGeneration === generation)
      setTransientStatus(describeError(error));
  } finally {
    if (loadingGap === requestGeneration) loadingGap = null;
  }
}
