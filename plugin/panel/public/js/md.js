// Minimal, safe Markdown for a plan's texts: paragraphs, “-” and “1.” lists, ``` code blocks,
// **bold**, *italic*, `code`, [links](https://…). Everything is escaped first; nothing else is
// interpreted. French typography (non-breaking spaces) applies only when the plan is in French.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
let lang = "fr";

export function setMdLang(value) {
  lang = value;
}

export function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function inline(text) {
  const saved = [];
  const keep = (html) => {
    saved.push(html);
    return `\u0000${saved.length - 1}\u0000`;
  };
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  // Links: http(s) only, opened in a new tab; the link text keeps its formatting.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>");
  if (lang === "fr") {
    // No guillemet or high punctuation mark left orphaned at a line break.
    out = out.replace(/« /g, "«&nbsp;").replace(/ »/g, "&nbsp;»").replace(/ ([:;?!])(?=\s|$|<)/g, "&nbsp;$1");
  }
  let previous;
  do {
    previous = out;
    out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]);
  } while (out !== previous);
  return out;
}

export function md(text) {
  if (!text) return "";
  const source = String(text).replace(/\r\n/g, "\n");
  const blocks = [];
  // Code blocks are set aside before splitting into paragraphs.
  const withoutCode = source.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre class="code-block"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\n\n\u0001${blocks.length - 1}\u0001\n\n`;
  });
  return withoutCode
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").filter((line) => line.trim() !== "");
      if (!lines.length) return "";
      const code = lines.length === 1 && lines[0].match(/^\u0001(\d+)\u0001$/);
      if (code) return blocks[Number(code[1])];
      if (lines.every((line) => /^\s*[-•*]\s+/.test(line))) {
        return `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-•*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (lines.every((line) => /^\s*\d+[.)]\s+/.test(line))) {
        return `<ol>${lines.map((line) => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
      }
      const heading = lines.length === 1 && lines[0].match(/^(#{1,4})\s+(.+)$/);
      if (heading) return `<p class="md-heading">${inline(heading[2])}</p>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

// Plain text (tooltips, attributes): without Markdown marks.
export function plain(text) {
  return String(text ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|`/g, "")
    .replace(/(^|\s)\*(\S[^*]*?)\*/g, "$1$2");
}
