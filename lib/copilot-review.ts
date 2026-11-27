// Reads the overview Copilot code review writes into its review body
// (`<!-- ccr-overview-v2 -->`): a verdict heading, a one-sentence summary and
// collapsible sections for open, previously missed and resolved issues.
import type { CopilotIssue, CopilotReview, CopilotVerdict } from "../contract";

/** GitHub login of Copilot code review in GraphQL `reviews(author:)`. */
export const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

const MAX_ISSUES = 20;
const MAX_TITLE = 300;
const MAX_SUMMARY = 1000;
const MAX_DETAIL = 1200;

const VERDICTS: [RegExp, CopilotVerdict][] = [
  [/needs a closer look/i, "closer_look"],
  [/changes recommended/i, "changes"],
  [/approval recommended/i, "approval"],
  [/^approved\b/i, "approved"],
];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
// Copilot breaks file paths with zero-width spaces so tables can wrap.
const clean = (text: string) => text.replace(/[​-‍⁠﻿]/g, "").replace(/\s+/g, " ").trim();
const severityOf = (html: string) => /alt="([^"]*?)\s*severity"/i.exec(html)?.[1]?.trim() || null;
const withoutPicture = (html: string) => html.replace(/<picture>[\s\S]*?<\/picture>/gi, " ");
/** Drops the leading emoji and markup from a heading such as `### 🔵 Needs a closer look`. */
const headingText = (line: string) => clean(line.replace(/^#+\s*/, "").replace(/<[^>]+>/g, "").replace(/^[^\p{L}\p{N}]+/u, ""));

function sectionOf(label: string): "open" | "missed" | "resolved" | "other" {
  if (/^\d+\s+open issues?$/i.test(label)) return "open";
  if (/^\d+\s+previously missed issues?$/i.test(label)) return "missed";
  if (/^\d+\s+resolved since last review$/i.test(label)) return "resolved";
  return "other";
}

function openIssue(line: string): CopilotIssue {
  const severity = severityOf(line);
  const rest = clean(withoutPicture(line.replace(/^\s*[-*]\s+/, "")));
  const link = /^\[(.+)\]\((https?:\/\/[^\s)]+)\)\s*(.*)$/.exec(rest);
  const title = clip(link ? link[1]! : rest, MAX_TITLE);
  const suffix = link ? link[3]! : "";
  return {
    kind: /(^|\W)New\b/.test(suffix) ? "new" : "still_open",
    severity, title, url: link ? link[2]! : null, location: null, detail: null,
  };
}

export function parseCopilotReviewBody(body: string): Pick<CopilotReview, "verdict" | "verdictLabel" | "summary" | "issues" | "resolvedCount"> {
  const lines = body.split(/\r?\n/);
  let verdict: CopilotVerdict = "unknown";
  let verdictLabel = "";
  let summary = "";
  const issues: CopilotIssue[] = [];
  let resolvedCount = 0;

  const headingIndex = lines.findIndex((line) => /^#{1,4}\s/.test(line.trim()) &&
    VERDICTS.some(([pattern]) => pattern.test(headingText(line))));
  if (headingIndex >= 0) {
    verdictLabel = headingText(lines[headingIndex]!);
    verdict = VERDICTS.find(([pattern]) => pattern.test(verdictLabel))![1];
    const paragraph: string[] = [];
    for (const raw of lines.slice(headingIndex + 1)) {
      const line = raw.trim();
      if (!line) { if (paragraph.length) break; continue; }
      if (/^(<|#|\||[-*]\s|\*\*No open issues)/i.test(line)) break;
      paragraph.push(line);
    }
    summary = clip(clean(paragraph.join(" ")), MAX_SUMMARY);
  }

  let depth = 0;
  let section: ReturnType<typeof sectionOf> | null = null;
  let missed: { severity: string | null; title: string; location: string | null; detail: string[] } | null = null;
  const finishMissed = () => {
    if (missed && missed.title) {
      const detail = clean(missed.detail.join(" "));
      issues.push({
        kind: "missed", severity: missed.severity, title: clip(missed.title, MAX_TITLE), url: null,
        location: missed.location, detail: detail ? clip(detail, MAX_DETAIL) : null,
      });
    }
    missed = null;
  };
  for (const raw of lines) {
    const line = raw.trim();
    depth += (line.match(/<details\b/gi) ?? []).length;
    const strong = /<summary>\s*<strong>(.+?)<\/strong>\s*<\/summary>/i.exec(line);
    if (strong && depth === 1) {
      section = sectionOf(clean(strong[1]!));
      if (section === "resolved") resolvedCount = Number(/^\d+/.exec(clean(strong[1]!))?.[0] ?? 0);
    } else if (section === "open" && depth === 1 && /^[-*]\s/.test(line)) {
      issues.push(openIssue(line));
    } else if (section === "missed" && depth === 2) {
      const heading = /<summary>([\s\S]*?)<\/summary>/i.exec(line);
      if (heading) {
        finishMissed();
        missed = { severity: severityOf(heading[1]!), title: clean(withoutPicture(heading[1]!).replace(/<[^>]+>/g, "")), location: null, detail: [] };
      } else if (missed && line && !/^<\/?details/i.test(line)) {
        const code = /^`([^`]+)`$/.exec(line);
        if (code && missed.location === null && missed.detail.length === 0) missed.location = clean(code[1]!);
        else missed.detail.push(line);
      }
    }
    const closes = (line.match(/<\/details>/gi) ?? []).length;
    if (closes) {
      depth = Math.max(0, depth - closes);
      if (depth < 2) finishMissed();
      if (depth === 0) section = null;
    }
  }
  finishMissed();
  return { verdict, verdictLabel, summary, issues: issues.slice(0, MAX_ISSUES), resolvedCount };
}
