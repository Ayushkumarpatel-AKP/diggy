import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

/** Result of turning a raw HTML document into clean, LLM-ready content. */
export interface ExtractResult {
  title: string;
  markdown: string;
}

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'head',
  'meta',
  'link',
  'canvas',
  'video',
  'audio',
  'object',
  'embed',
]);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'dialog',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hgroup',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'ul',
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}

function escapeInlineText(value: string): string {
  // Escape only the characters that would otherwise be interpreted as markdown
  // syntax mid-word and that can appear in ordinary prose we must not lose.
  return value.replace(/[\\`]/g, (match) => `\\${match}`);
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join('\n');
}

function prefixLines(text: string, prefix: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? prefix + line : prefix.trimEnd()))
    .join('\n');
}

function cleanupMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert a parsed DOM subtree into Markdown.
 *
 * Split out from {@link htmlToMarkdown} so callers that already hold a parsed
 * `Document` (e.g. Readability output) can reuse the same converter without
 * re-serializing to HTML first.
 */
function convertToMarkdown(root: Node, baseUrl?: string): string {
  function resolveUrl(value: string | null): string | null {
    if (!value) return null;
    if (!baseUrl) return value;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return value;
    }
  }

  function renderChildren(parent: Node): string {
    let out = '';
    for (const child of Array.from(parent.childNodes)) {
      out += renderNode(child);
    }
    return out;
  }

  function renderInline(element: Element): string {
    return renderChildren(element);
  }

  function renderList(list: Element): string {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const items = Array.from(list.children).filter(
      (child) => child.tagName.toLowerCase() === 'li',
    );
    const lines: string[] = [];

    items.forEach((item, index) => {
      const marker = ordered ? `${index + 1}. ` : '- ';
      const nested: Element[] = [];
      let content = '';

      for (const child of Array.from(item.childNodes)) {
        const tag = child.nodeType === 1 ? (child as Element).tagName.toLowerCase() : '';
        if (tag === 'ul' || tag === 'ol') {
          nested.push(child as Element);
        } else {
          content += renderNode(child);
        }
      }

      lines.push(`${marker}${content.trim()}`);
      for (const sub of nested) {
        lines.push(indent(renderList(sub), '  '));
      }
    });

    return lines.join('\n');
  }

  function renderTable(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr'))
      .map((row) =>
        Array.from(row.children)
          .filter((cell) => {
            const tag = cell.tagName.toLowerCase();
            return tag === 'td' || tag === 'th';
          })
          .map((cell) => renderChildren(cell).replace(/\s+/g, ' ').trim()),
      )
      .filter((row) => row.length > 0);

    const first = rows[0];
    if (!first) return '';

    const columnCount = Math.max(1, ...rows.map((row) => row.length));
    const pad = (row: string[]): string[] => {
      const copy = row.slice(0, columnCount);
      while (copy.length < columnCount) copy.push('');
      return copy;
    };

    const header = pad(first);
    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
    ];
    for (const row of rows.slice(1)) {
      lines.push(`| ${pad(row).join(' | ')} |`);
    }
    return lines.join('\n');
  }

  function renderNode(node: Node): string {
    if (node.nodeType === 3) {
      return escapeInlineText(collapseWhitespace(node.nodeValue ?? ''));
    }
    if (node.nodeType !== 1) return '';

    const element = node as Element;
    const tag = element.tagName.toLowerCase();

    if (SKIP_TAGS.has(tag)) return '';

    switch (tag) {
      case 'br':
        return '  \n';
      case 'hr':
        return '\n\n---\n\n';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number.parseInt(tag.slice(1), 10);
        return `\n\n${'#'.repeat(level)} ${renderInline(element).trim()}\n\n`;
      }
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'main':
      case 'header':
      case 'footer':
      case 'aside':
      case 'nav':
      case 'figure':
      case 'figcaption':
      case 'details':
      case 'summary':
      case 'dd':
      case 'dt':
      case 'address':
        return `\n\n${renderInline(element).trim()}\n\n`;
      case 'strong':
      case 'b': {
        const text = renderInline(element).trim();
        return text ? `**${text}**` : '';
      }
      case 'em':
      case 'i': {
        const text = renderInline(element).trim();
        return text ? `*${text}*` : '';
      }
      case 'del':
      case 's':
      case 'strike': {
        const text = renderInline(element).trim();
        return text ? `~~${text}~~` : '';
      }
      case 'code':
        return `\`${collapseWhitespace(element.textContent ?? '').trim()}\``;
      case 'pre': {
        const code = (element.textContent ?? '').replace(/^\n+|\n+$/g, '');
        const language =
          element.querySelector('code')?.className.match(/language-([\w-]+)/)?.[1] ?? '';
        return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
      }
      case 'blockquote':
        return `\n\n${prefixLines(renderInline(element), '> ')}\n\n`;
      case 'a': {
        const href = resolveUrl(element.getAttribute('href'));
        const label = renderInline(element).trim();
        if (!href) return label;
        return label ? `[${label}](${href})` : `[${href}](${href})`;
      }
      case 'img': {
        const src = resolveUrl(element.getAttribute('src'));
        const alt = element.getAttribute('alt') ?? '';
        return src ? `![${alt}](${src})` : '';
      }
      case 'ul':
      case 'ol':
        return `\n\n${renderList(element)}\n\n`;
      case 'li':
        return renderInline(element);
      case 'table':
        return `\n\n${renderTable(element)}\n\n`;
      default:
        if (BLOCK_TAGS.has(tag)) {
          return `\n\n${renderInline(element)}\n\n`;
        }
        return renderInline(element);
    }
  }

  return cleanupMarkdown(renderChildren(root));
}

/** Convert an HTML **string** into Markdown. `baseUrl` resolves relative links. */
export function htmlToMarkdown(html: string, baseUrl?: string): string {
  if (!html || !html.trim()) return '';
  const dom = new JSDOM(html);
  return convertToMarkdown(dom.window.document.body, baseUrl);
}

/**
 * Extract the readable article from a raw HTML document and return it as
 * clean Markdown. Uses `@mozilla/readability` for the main-content heuristic
 * and falls back to the whole `<body>` when no article is detected.
 *
 * Fully offline — nothing here performs network requests.
 */
export function extractFromHtml(html: string, url?: string): ExtractResult {
  const dom = new JSDOM(html, url ? { url } : undefined);
  const document = dom.window.document;

  let title = (document.title ?? '').trim();
  let content = '';
  let textFallback = '';

  try {
    // Readability mutates the document it is given, so hand it a clone to keep
    // the original DOM intact for the fallback path. `keepClasses` preserves the
    // `language-*` hint on <code> blocks so fenced code keeps its language tag.
    const reader = new Readability(document.cloneNode(true) as Document, {
      keepClasses: true,
    });
    const article = reader.parse();
    if (article) {
      title = (article.title || title).trim();
      content = article.content ?? '';
      textFallback = article.textContent ?? '';
    }
  } catch {
    // Ignore Readability failures and fall back to the raw document.
  }

  let markdown: string;
  if (content && content.trim()) {
    markdown = htmlToMarkdown(content, url);
  } else {
    markdown = convertToMarkdown(document.body, url);
    if (!title) title = (document.title ?? '').trim();
  }

  if (!markdown.trim()) {
    markdown = collapseWhitespace(textFallback || document.body?.textContent || '').trim();
  }

  return { title, markdown: markdown.trim() };
}
