import { highlightCode } from "./codeHighlight";
import { escapeHtml } from "./util/html";
export interface BodyContext {
  meUsername?: string;
  membersByUsername: ReadonlyMap<string, unknown>;
  channelsByName: ReadonlyMap<string, { id: string }>;
}
const MENTION_RE_GLOBAL = /(^|[^A-Za-z0-9_])@([a-z0-9_]{3,32})/g;
const EVERYONE_RE_GLOBAL = /(^|[^A-Za-z0-9_])@(everyone|here)\b/g;
const CHANNEL_RE_GLOBAL = /(^|[^\p{L}\p{N}_#])#([\p{L}\p{N}_-]{1,64})/gu;
const FENCED_RE = /```(?:([A-Za-z0-9+#-]{1,20})\n)?([\s\S]*?)```/g;
const MD_ESCAPE_RE = /\\([\\*_~|`])/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const URL_RE = /\bhttps?:\/\/[^\s<>`]+/g;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const ITALIC_RE = /(^|[^A-Za-z0-9_])_([^_\n]+?)_(?=[^A-Za-z0-9_]|$)/g;
const ITALIC_STAR_RE = /\*(?!\s)([^*\n]+?)(?<!\s)\*/g;
const STRIKE_RE = /~~([^~\n]+?)~~/g;
const SPOILER_RE = /\|\|([^|\n]+?)\|\|/g;
export function renderBody(
  body: string,
  mentionEveryone: string | undefined,
  context: BodyContext,
): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = `${placeholders.length}`;
    placeholders.push(html);
    return token;
  };

  // 1) Fenced code blocks — самый высокий приоритет, чтобы внутри
  //    не интерпретировались **, _, бэктики и т.д. Wave 2: ```lang →
  //    подсветка через highlight.js (highlightCode сам эскейпит).
  let text = body.replace(
    FENCED_RE,
    (_, lang: string | undefined, raw: string) => {
      const stripped = raw.replace(/^\n/, "").replace(/\n$/, "");
      const { html, language } = highlightCode(stripped, lang ?? null);
      const langBadge = language
        ? `<span class="md-code-lang">${escapeHtml(language)}</span>`
        : "";
      return stash(
        `<pre class="md-code-block">${langBadge}<code class="hljs">${html}</code></pre>`,
      );
    },
  );

  // 2) Inline code.
  text = text.replace(INLINE_CODE_RE, (_, raw: string) =>
    stash(`<code class="md-code">${escapeHtml(raw)}</code>`),
  );

  // 2.5) Backslash-escape: `\*` и т.п. → литеральный символ, маркером
  //      не считается (стэшится до остальных markdown-проходов).
  text = text.replace(MD_ESCAPE_RE, (_, ch: string) => stash(escapeHtml(ch)));

  // 3) URL autolink. Хвостовые пунктуации (.,!?;:)) отрезаем, чтобы
  //    «загляни http://x.com.» не съело точку.
  text = text.replace(URL_RE, (url: string) => {
    let trimmed = url;
    let trail = "";
    while (
      trimmed.length > 0 &&
      /[.,!?;:)\]]/.test(trimmed[trimmed.length - 1])
    ) {
      trail = trimmed[trimmed.length - 1] + trail;
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed.length === 0) return url;
    const safe = escapeHtml(trimmed);
    return (
      stash(
        `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>`,
      ) + trail
    );
  });

  // 4) Mentions.
  const knownUsernames = context.membersByUsername;
  const me = context.meUsername;
  text = text.replace(
    MENTION_RE_GLOBAL,
    (full: string, prefix: string, slug: string) => {
      if (!knownUsernames.has(slug)) return full;
      const isMe = me === slug;
      return (
        prefix +
        stash(
          `<span class="mention${isMe ? " mention-self" : ""}">@${escapeHtml(slug)}</span>`,
        )
      );
    },
  );

  // 4.5) @everyone/@here — только если сервер подтвердил пинг (право было).
  if (mentionEveryone) {
    text = text.replace(
      EVERYONE_RE_GLOBAL,
      (_full: string, prefix: string, token: string) =>
        prefix +
        stash(`<span class="mention mention-everyone">@${token}</span>`),
    );
  }

  // 4.7) #channel-ссылки (Wave 8). Клик обрабатывается делегатом на
  // message-list (data-channel-link → selectChannel). Архивные каналы
  // линкуются тоже — это и есть «доступен по прямой ссылке».
  const knownChannels = context.channelsByName;
  text = text.replace(
    CHANNEL_RE_GLOBAL,
    (full: string, prefix: string, name: string) => {
      const ch = knownChannels.get(name.toLowerCase());
      if (!ch) return full;
      return (
        prefix +
        stash(
          `<span class="channel-link" data-channel-link="${ch.id}">#${escapeHtml(name)}</span>`,
        )
      );
    },
  );

  // 5) Эскейпим всё оставшееся. Плейсхолдеры (N) состоят
  //    только из управляющего символа и цифр — escapeHtml их не трогает.
  text = escapeHtml(text);

  // 6) Bold / italic поверх уже escape'нутого текста. `*` и `_` в
  //    escapeHtml не входят, поэтому регулярки видят их как есть.
  text = text.replace(BOLD_RE, "<strong>$1</strong>");
  text = text.replace(STRIKE_RE, "<del>$1</del>");
  text = text.replace(ITALIC_RE, "$1<em>$2</em>");
  // Asterisk-italic после bold (иначе `**x**` распался бы на `*` + `*x*`).
  text = text.replace(ITALIC_STAR_RE, "<em>$1</em>");
  text = text.replace(
    SPOILER_RE,
    '<span class="spoiler" data-spoiler>$1</span>',
  );

  // 7) Возврат плейсхолдеров.
  return text.replace(
    /(\d+)/g,
    (_, idx: string) => placeholders[Number(idx)] ?? "",
  );
}
