// Copilot code review bodies with the markup Copilot posts (`ccr-overview-v2`),
// rebuilt with neutral text from the structure of real reviews.
const icon = (severity) => {
  const name = severity.toLowerCase();
  const base = "https://github.githubassets.com/static/images/icons/copilot-code-review";
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${base}/${name}-v2-dark.svg"><source media="(prefers-color-scheme: light)" srcset="${base}/${name}-v2-light.svg"><img src="${base}/${name}-v2-light.png" alt="${severity} severity" width="62" height="18" align="texttop"></picture>`;
};
const HEADINGS = {
  closer_look: "### 🔵 Needs a closer look",
  changes: "### 🟡 Changes recommended",
  approval: "### 🟢 Approval recommended",
  approved: "### 🟢 Approved",
};
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * open: [{ severity, title, url, isNew }], missed: [{ severity, title, location, detail }],
 * resolved: [{ severity, title, url }]
 */
export function copilotBody({ verdict = "closer_look", summary = "Human assessment is needed to check the retry path.", open = [], missed = [], resolved = [] } = {}) {
  const parts = ["<!-- ccr-overview-v2 -->", "", HEADINGS[verdict], "", summary, ""];
  if (open.length) {
    parts.push("<details open>", `<summary><strong>${plural(open.length, "open issue")}</strong></summary>`, "");
    for (const issue of open) parts.push(`- ${icon(issue.severity)} [${issue.title}](${issue.url})${issue.isNew ? " · New" : ""}`);
    parts.push("</details>", "");
  } else {
    parts.push("**No open issues** 🎉", "");
  }
  if (missed.length) {
    parts.push("<details>", `<summary><strong>${plural(missed.length, "previously missed issue")}</strong></summary>`, "", "In code that hasn't changed since last review", "");
    for (const issue of missed) {
      // Copilot breaks paths with zero-width spaces after each slash.
      parts.push("<details>", `<summary>${icon(issue.severity)} ${issue.title}</summary>`, "", `\`${issue.location.replaceAll("/", "/​")}\``, "", issue.detail, "</details>");
    }
    parts.push("</details>", "");
  }
  if (resolved.length) {
    parts.push("<details>", `<summary><strong>${resolved.length} resolved since last review</strong></summary>`, "");
    for (const issue of resolved) parts.push(`- ${icon(issue.severity)} [${issue.title}](${issue.url})`);
    parts.push("</details>", "");
  }
  parts.push(
    "<details>", "<summary><strong>What changed in this PR</strong></summary>", "",
    "Adds a retry path.", "", "**Changes:**", "- Adds a retry.", "",
    "| File | Description |", "| ---- | ----------- |", "| `src/​retry.ts` | Adds a retry. |",
    "</details>", "", "<sub>Review effort: Balanced</sub>",
  );
  return parts.join("\n");
}

export const discussion = (n, id) => `https://github.com/o/r/pull/${n}#discussion_r${id}`;
