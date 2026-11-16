(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.YDAMarkdown = api;
})(globalThis, function () {
  'use strict';

  // A deliberately small Markdown subset. Every source fragment is escaped;
  // only the fixed tags below and a validated HTTP(S) href can become markup.
  const escapeHTML = (text) => text.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
  const textLines = (text) => escapeHTML(text).replace(/\n/g, '<br>');
  const word = (char) => Boolean(char && /[\p{L}\p{N}_]/u.test(char));
  const safeURL = (url) => /^https?:\/\/[^/?#\s<>"'\\\u0000-\u001f\u007f]+(?:[/?#][^\s<>"'\\\u0000-\u001f\u007f]*)?$/i.test(url);

  function escaped(text, at) {
    let slashes = 0;
    while (at > 0 && text[--at] === '\\') slashes += 1;
    return slashes % 2 === 1;
  }

  function closing(text, marker, from) {
    let at = text.indexOf(marker, from);
    while (at !== -1 && escaped(text, at)) at = text.indexOf(marker, at + marker.length);
    return at;
  }

  function mathAt(text, at) {
    return text.startsWith('$$', at) ? ['$$', '$$'] : text[at] === '$' ? ['$', '$']
      : text.startsWith('\\(', at) ? ['\\(', '\\)'] : text.startsWith('\\[', at) ? ['\\[', '\\]'] : null;
  }

  function linkAt(text, at) {
    const image = text[at] === '!';
    const start = at + (image ? 2 : 1);
    const end = closing(text, ']', start);
    if (end === -1 || text[end + 1] !== '(') return null;
    let cursor = end + 2, level = 1;
    for (; cursor < text.length; cursor += 1) {
      if (escaped(text, cursor)) continue;
      if (text[cursor] === '(') level += 1;
      if (text[cursor] === ')' && --level === 0) break;
    }
    if (level) return null;
    let url = text.slice(end + 2, cursor).trim();
    if (url.startsWith('<') && url.endsWith('>')) url = url.slice(1, -1);
    return { image, label: text.slice(start, end), url, end: cursor + 1 };
  }

  function inline(text, depth = 0, insideLink = false) {
    if (depth > 16) return textLines(text);
    const output = [];
    for (let at = 0; at < text.length;) {
      // Preserve formula notation literally; neither evaluate nor style its
      // underscores, operators, delimiters or HTML-looking comparisons.
      const math = mathAt(text, at);
      if (math) {
        const end = closing(text, math[1], at + math[0].length);
        if (end !== -1) {
          output.push(textLines(text.slice(at, end + math[1].length)));
          at = end + math[1].length;
          continue;
        }
      }
      if (text[at] === '\\' && /[\\`*_[\]{}()!#|>]/.test(text[at + 1] || '')) {
        output.push(escapeHTML(text[at + 1]));
        at += 2;
        continue;
      }
      if (text[at] === '`') {
        const marker = /^`+/.exec(text.slice(at))[0];
        let end = text.indexOf(marker, at + marker.length);
        while (end !== -1 && (text[end - 1] === '`' || text[end + marker.length] === '`')) {
          end = text.indexOf(marker, end + marker.length);
        }
        if (end !== -1) {
          output.push(`<code>${escapeHTML(text.slice(at + marker.length, end))}</code>`);
          at = end + marker.length;
          continue;
        }
        output.push(marker);
        at += marker.length;
        continue;
      }
      if (!insideLink && (text[at] === '[' || text.startsWith('![', at))) {
        const link = linkAt(text, at);
        if (link) {
          const label = link.image ? textLines(link.label) : inline(link.label, depth + 1, true);
          output.push(!link.image && safeURL(link.url)
            ? `<a href="${escapeHTML(link.url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label);
          at = link.end;
          continue;
        }
      }
      const marker = text.startsWith('**', at) ? '**' : text.startsWith('__', at) ? '__'
        : text[at] === '*' ? '*' : text[at] === '_' ? '_' : null;
      if (marker && /\S/.test(text[at + marker.length] || '') && !(marker[0] === '_' && word(text[at - 1]))) {
        let end = closing(text, marker, at + marker.length);
        while (end !== -1 && (!/\S/.test(text[end - 1])
          || (marker[0] === '_' && word(text[end + marker.length])))) {
          end = closing(text, marker, end + marker.length);
        }
        if (end > at + marker.length) {
          const tag = marker.length === 2 ? 'strong' : 'em';
          output.push(`<${tag}>${inline(text.slice(at + marker.length, end), depth + 1, insideLink)}</${tag}>`);
          at = end + marker.length;
          continue;
        }
      }
      output.push(text[at] === '\n' ? '<br>' : escapeHTML(text[at]));
      at += 1;
    }
    return output.join('');
  }

  const fence = (line) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const heading = (line) => /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  const quote = (line) => /^ {0,3}>[ \t]?(.*)$/.exec(line);
  const list = (line) => /^ {0,3}(?:(\d{1,9})[.)]|([-+*]))[ \t]+(.+)$/.exec(line);

  function cells(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !escaped(text, text.length - 1)) text = text.slice(0, -1);
    const result = [];
    let start = 0, code = '';
    for (let at = 0; at < text.length; at += 1) {
      if (escaped(text, at)) continue;
      const math = !code && mathAt(text, at);
      if (math) {
        const end = closing(text, math[1], at + math[0].length);
        if (end !== -1) {
          at = end + math[1].length - 1;
          continue;
        }
      }
      if (text[at] === '`') {
        const marker = /^`+/.exec(text.slice(at))[0];
        if (!code) code = marker;
        else if (code === marker) code = '';
        at += marker.length - 1;
      } else if (text[at] === '|' && !code) {
        result.push(text.slice(start, at).trim());
        start = at + 1;
      }
    }
    result.push(text.slice(start).trim());
    return result;
  }

  function tableAt(lines, at) {
    if (at + 1 >= lines.length || !lines[at].includes('|')) return false;
    const header = cells(lines[at]), separator = cells(lines[at + 1]);
    return header.length === separator.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function blocks(lines, depth = 0) {
    if (depth > 16) return `<p>${textLines(lines.join('\n'))}</p>`;
    const output = [];
    for (let at = 0; at < lines.length;) {
      const line = lines[at];
      if (!line.trim()) { at += 1; continue; }
      const open = fence(line);
      if (open) {
        const code = [];
        const end = new RegExp(`^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`);
        at += 1;
        while (at < lines.length && !end.test(lines[at])) code.push(lines[at++]);
        if (at < lines.length) at += 1;
        output.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
        continue;
      }
      const mathEnd = line.trim() === '$$' ? '$$' : line.trim() === '\\[' ? '\\]' : null;
      if (mathEnd) {
        const formula = [line];
        at += 1;
        while (at < lines.length) {
          const current = lines[at++];
          formula.push(current);
          if (current.trim() === mathEnd) break;
        }
        output.push(`<p class="markdown-math">${textLines(formula.join('\n'))}</p>`);
        continue;
      }
      const title = heading(line);
      if (title) {
        const level = Math.min(6, title[1].length + 2);
        output.push(`<h${level}>${inline((title[2] || '').replace(/[ \t]+#+[ \t]*$/, ''))}</h${level}>`);
        at += 1;
        continue;
      }
      if (quote(line)) {
        const contents = [];
        while (at < lines.length && quote(lines[at])) contents.push(quote(lines[at++])[1]);
        output.push(`<blockquote>${blocks(contents, depth + 1)}</blockquote>`);
        continue;
      }
      if (tableAt(lines, at)) {
        const header = cells(line), body = [];
        at += 2;
        while (at < lines.length && lines[at].trim() && lines[at].includes('|')
          && !fence(lines[at]) && !heading(lines[at]) && !quote(lines[at]) && !list(lines[at])) {
          const values = cells(lines[at++]);
          body.push(`<tr>${header.map((_, index) => `<td>${inline(values[index] || '')}</td>`).join('')}</tr>`);
        }
        output.push(`<div class="markdown-table-wrap"><table><thead><tr>${header.map((cell) => `<th scope="col">${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`);
        continue;
      }
      const item = list(line);
      if (item) {
        const ordered = item[1] !== undefined, contents = [];
        while (at < lines.length) {
          const next = list(lines[at]);
          if (!next || (next[1] !== undefined) !== ordered) break;
          const value = [next[3]];
          at += 1;
          while (at < lines.length && /^ {2,}\S/.test(lines[at]) && !list(lines[at]) && !fence(lines[at])) {
            value.push(lines[at++].trim());
          }
          contents.push(`<li>${inline(value.join('\n'))}</li>`);
        }
        const tag = ordered ? 'ol' : 'ul';
        const start = ordered && Number(item[1]) !== 1 ? ` start="${Number(item[1])}"` : '';
        output.push(`<${tag}${start}>${contents.join('')}</${tag}>`);
        continue;
      }
      const paragraph = [line];
      at += 1;
      while (at < lines.length && lines[at].trim() && !fence(lines[at]) && !heading(lines[at])
        && !quote(lines[at]) && !list(lines[at]) && !tableAt(lines, at)
        && !['$$', '\\['].includes(lines[at].trim())) paragraph.push(lines[at++]);
      output.push(`<p>${inline(paragraph.join('\n'))}</p>`);
    }
    return output.join('\n');
  }

  function render(markdown) {
    if (markdown == null || markdown === '') return '';
    if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
    return blocks(markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n'));
  }

  return Object.freeze({ render });
});
