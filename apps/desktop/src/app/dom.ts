import morphdom from "morphdom";

// Keys keep media elements and message rows alive across updates.
function nodeKey(node: Node): string | undefined {
  if (!(node instanceof HTMLElement)) return undefined;
  if (node.id) return node.id;
  if (node.dataset.rowId) return `row:${node.dataset.rowId}`;
  if (node.classList.contains("message"))
    return `message:${node.dataset.id ?? node.dataset.revealBlocked}`;
  for (const key of [
    "voicePeer",
    "voiceSelf",
    "callSelf",
    "callRemote",
    "memberUser",
    "ws",
    "ch",
  ]) {
    if (node.dataset[key] !== undefined)
      return `${node.tagName}:${key}:${node.dataset[key]}`;
  }
  return undefined;
}

export function patchChildren(element: HTMLElement, html: string): void {
  const target = element.cloneNode(false) as HTMLElement;
  target.innerHTML = html;
  morphdom(element, target, {
    childrenOnly: true,
    getNodeKey: nodeKey,
    onBeforeElUpdated(from, to) {
      if (
        from.dataset.mediaUrl &&
        from.dataset.mediaUrl === to.dataset.mediaUrl &&
        from.querySelector("img")
      )
        return false;
      if (
        from.dataset.avatarMedia &&
        from.dataset.avatarMedia === to.dataset.avatarMedia &&
        from.querySelector("img")
      )
        return false;
      if (from.classList.contains("speaking")) to.classList.add("speaking");
      if (
        from.classList.contains("revealed") &&
        to.hasAttribute("data-spoiler")
      )
        to.classList.add("revealed");
      if (
        (from instanceof HTMLInputElement ||
          from instanceof HTMLTextAreaElement) &&
        (from === document.activeElement ||
          (from.value !== from.defaultValue &&
            from.getAttribute("value") === to.getAttribute("value")))
      ) {
        (to as HTMLInputElement).value = from.value;
      }
      return !from.isEqualNode(to);
    },
  });
}

export function patchElement(element: HTMLElement, html: string): void {
  const target = document.createElement("template");
  target.innerHTML = html.trim();
  const next = target.content.firstElementChild as HTMLElement | null;
  if (!next) {
    element.remove();
    return;
  }
  patchChildren(element, next.innerHTML);
  for (const attr of [...element.attributes])
    if (!next.hasAttribute(attr.name)) element.removeAttribute(attr.name);
  for (const attr of [...next.attributes])
    element.setAttribute(attr.name, attr.value);
}

type Binding = {
  listener: EventListener;
  options?: boolean | AddEventListenerOptions;
};
const bindings = new WeakMap<EventTarget, Map<string, Binding>>();
export function bindEvent<K extends keyof HTMLElementEventMap>(
  element: EventTarget | null | undefined,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => unknown,
  key: string,
  options?: boolean | AddEventListenerOptions,
): void {
  if (!element) return;
  let map = bindings.get(element);
  if (!map) {
    map = new Map();
    bindings.set(element, map);
  }
  const old = map.get(key);
  if (old) element.removeEventListener(type, old.listener, old.options);
  const listener = handler as EventListener;
  element.addEventListener(type, listener, options);
  map.set(key, { listener, options });
}

export function delegate<
  T extends HTMLElement,
  K extends keyof HTMLElementEventMap,
>(
  root: HTMLElement,
  selector: string,
  type: K,
  handler: (event: HTMLElementEventMap[K], element: T) => unknown,
  key: string,
): void {
  bindEvent(
    root,
    type,
    (event) => {
      const element = (event.target as Element | null)?.closest<T>(selector);
      if (!element || !root.contains(element)) return;
      // Native Event getters/methods retain their receiver; currentTarget is the matched control.
      const proxy = new Proxy(event, {
        get(target, property) {
          if (property === "currentTarget") return element;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      void handler(proxy, element);
    },
    key,
  );
}
