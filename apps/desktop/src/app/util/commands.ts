import type { SlashAction } from "../types";

export function transformSlashCommand(body: string): SlashAction {
  if (!body.startsWith("/")) return { kind: "send", body };
  const sp = body.indexOf(" ");
  const cmd = (sp === -1 ? body.slice(1) : body.slice(1, sp)).toLowerCase();
  const arg = sp === -1 ? "" : body.slice(sp + 1).trim();
  switch (cmd) {
    case "shrug":
      // Backslash перед `_` — чтобы renderBody не превратил (ツ) в курсив
      // (MD_ESCAPE_RE стэшит литеральный символ).
      return { kind: "send", body: `${arg ? arg + " " : ""}¯\\_(ツ)\\_/¯` };
    case "tableflip":
      return { kind: "send", body: `${arg ? arg + " " : ""}(╯°□°)╯︵ ┻━┻` };
    case "unflip":
      return { kind: "send", body: `${arg ? arg + " " : ""}┬─┬ ノ( ゜-゜ノ)` };
    case "me":
      return { kind: "send", body: arg ? `*${arg}*` : body };
    case "spoiler":
      return { kind: "send", body: arg ? `||${arg}||` : body };
    case "nick":
      return { kind: "nick", name: arg };
    default:
      return { kind: "send", body };
  }
}
