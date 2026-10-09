import type { PermDraft } from "../types";

// Сворачивает PermDraft в список {key, granted, denied}, пропуская
// полностью «наследуемые» записи. key — roleCode либо userId.
export function permDraftToList(
  draft: PermDraft,
): Array<{ key: string; granted: string[]; denied: string[] }> {
  const out: Array<{ key: string; granted: string[]; denied: string[] }> = [];
  for (const key of Object.keys(draft)) {
    const granted: string[] = [];
    const denied: string[] = [];
    for (const action of Object.keys(draft[key])) {
      const v = draft[key][action];
      if (v === "grant") granted.push(action);
      else if (v === "deny") denied.push(action);
    }
    if (granted.length === 0 && denied.length === 0) continue;
    out.push({ key, granted, denied });
  }
  return out;
}
