import type { Message } from "../types";
const messageHtmlCache = new WeakMap<
  Message,
  { context: string; html: string }
>();
let messageContextVersion = 0;
let lastMessageContext: unknown[] = [];
const renderedRows = new WeakMap<HTMLElement, string>();
export const messageListState = {
  get messageHtmlCache() {
    return messageHtmlCache;
  },
  get messageContextVersion() {
    return messageContextVersion;
  },
  set messageContextVersion(value: typeof messageContextVersion) {
    messageContextVersion = value;
  },
  get lastMessageContext() {
    return lastMessageContext;
  },
  set lastMessageContext(value: typeof lastMessageContext) {
    lastMessageContext = value;
  },
  get renderedRows() {
    return renderedRows;
  },
};
