import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import bash from "@shikijs/langs/bash";
import cpp from "@shikijs/langs/cpp";
import csharp from "@shikijs/langs/csharp";
import css from "@shikijs/langs/css";
import diffLang from "@shikijs/langs/diff";
import dockerfile from "@shikijs/langs/dockerfile";
import go from "@shikijs/langs/go";
import html from "@shikijs/langs/html";
import java from "@shikijs/langs/java";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import markdown from "@shikijs/langs/markdown";
import php from "@shikijs/langs/php";
import python from "@shikijs/langs/python";
import ruby from "@shikijs/langs/ruby";
import rust from "@shikijs/langs/rust";
import sql from "@shikijs/langs/sql";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";
import darkPlus from "@shikijs/themes/dark-plus";
import lightPlus from "@shikijs/themes/light-plus";
import { escapeHtml } from "../../html.js";

const SHIKI_THEMES = [darkPlus, lightPlus];

const SHIKI_LANGUAGES = [
  bash,
  cpp,
  csharp,
  css,
  diffLang,
  dockerfile,
  go,
  html,
  java,
  javascript,
  jsx,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  typescript,
  tsx,
  xml,
  yaml
];

let shikiHighlighter: Awaited<ReturnType<typeof createHighlighterCore>> | undefined;

let shikiStarted = false;

export function startShiki(onReady: () => void): void {
  if (shikiStarted) return;
  shikiStarted = true;
  void createHighlighterCore({
    themes: SHIKI_THEMES,
    langs: SHIKI_LANGUAGES,
    engine: createJavaScriptRegexEngine()
  }).then(highlighter => {
    shikiHighlighter = highlighter;
    onReady();
  }).catch(() => {
    shikiHighlighter = undefined;
  });
}

export function normalizeHighlightLanguage(language: string): string | undefined {
  const raw = language.trim().toLowerCase();
  if (!raw) return undefined;
  const aliases: Record<string, string> = {
    cplusplus: "cpp",
    h: "cpp",
    hpp: "cpp",
    htm: "html",
    html: "html",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    py: "python",
    shell: "bash",
    sh: "bash",
    ts: "typescript",
    tsx: "tsx",
    zsh: "bash"
  };
  return aliases[raw] ?? raw;
}

export function highlightCode(code: string, language: string | undefined): string {
  if (!code) return "";
  const highlighter = shikiHighlighter;
  if (!language || !highlighter) return escapeHtml(code);
  try {
    const html = highlighter.codeToHtml(code, {
      lang: language,
      theme: currentShikiTheme()
    });
    return extractShikiCode(html);
  } catch {
    return escapeHtml(code);
  }
}

function currentShikiTheme(): string {
  return document.body.classList.contains("vscode-light") ? "light-plus" : "dark-plus";
}

function extractShikiCode(html: string): string {
  const match = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html);
  return match?.[1] ?? html;
}

export function highlightLanguageForPath(filePath: string): string | undefined {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const map: Record<string, string> = {
    bash: "bash",
    c: "cpp",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    dockerfile: "dockerfile",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    htm: "xml",
    html: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    mjs: "javascript",
    md: "markdown",
    markdown: "markdown",
    php: "php",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml"
  };
  return map[ext];
}
