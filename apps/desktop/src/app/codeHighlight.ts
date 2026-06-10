// Wave 2: подсветка синтаксиса в fenced-блоках (```lang … ```). highlight.js
// core + курируемый набор популярных языков — полный пакет (190+ языков)
// раздул бы бандл в разы. Без указанного языка код остаётся plain (как в
// Discord) — авто-детект медленный и часто ошибается на коротких сниппетах.
//
// Безопасность: hljs.highlight() сам эскейпит исходник; на plain-пути
// эскейпим вручную. Возвращаемое значение — ГОТОВЫЙ безопасный HTML.

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import json from "highlight.js/lib/languages/json";
import bash from "highlight.js/lib/languages/bash";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import yaml from "highlight.js/lib/languages/yaml";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import csharp from "highlight.js/lib/languages/csharp";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import php from "highlight.js/lib/languages/php";
import ruby from "highlight.js/lib/languages/ruby";
import lua from "highlight.js/lib/languages/lua";
import ini from "highlight.js/lib/languages/ini";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import diff from "highlight.js/lib/languages/diff";
import markdown from "highlight.js/lib/languages/markdown";

hljs.registerLanguage("javascript", javascript); // + js, jsx
hljs.registerLanguage("typescript", typescript); // + ts, tsx
hljs.registerLanguage("python", python); // + py
hljs.registerLanguage("go", go); // + golang
hljs.registerLanguage("rust", rust); // + rs
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash); // + sh, shell, zsh
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("xml", xml); // + html, svg
hljs.registerLanguage("css", css);
hljs.registerLanguage("yaml", yaml); // + yml
hljs.registerLanguage("cpp", cpp); // + c++, cc, hpp
hljs.registerLanguage("c", c); // + h
hljs.registerLanguage("csharp", csharp); // + cs
hljs.registerLanguage("java", java);
hljs.registerLanguage("kotlin", kotlin); // + kt
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("php", php);
hljs.registerLanguage("ruby", ruby); // + rb
hljs.registerLanguage("lua", lua);
hljs.registerLanguage("ini", ini); // + toml
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("diff", diff); // + patch
hljs.registerLanguage("markdown", markdown); // + md

// Частые алиасы, которых нет среди зарегистрированных имён hljs по умолчанию.
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  node: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  golang: "go",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  powershell: "bash", // близко к истине нет — лучше bash-токены, чем plain
  ps1: "bash",
  html: "xml",
  svg: "xml",
  yml: "yaml",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  h: "c",
  cs: "csharp",
  kt: "kotlin",
  rb: "ruby",
  toml: "ini",
  patch: "diff",
  md: "markdown"
};

function escapePlain(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Возвращает безопасный HTML тела код-блока (+ нормализованный язык или null). */
export function highlightCode(code: string, lang: string | null): { html: string; language: string | null } {
  if (lang) {
    const norm = lang.toLowerCase();
    const resolved = hljs.getLanguage(norm) ? norm : ALIASES[norm];
    if (resolved && hljs.getLanguage(resolved)) {
      try {
        return { html: hljs.highlight(code, { language: resolved }).value, language: resolved };
      } catch {
        /* упало на экзотике — отдаём plain */
      }
    }
  }
  return { html: escapePlain(code), language: null };
}
