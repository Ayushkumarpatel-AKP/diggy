import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { extractFromHtml, htmlToMarkdown } from './extract.js';

export interface MarkdownInput {
  /** Base64-encoded file contents. */
  base64: string;
  /** Original filename — its extension selects the converter. */
  filename: string;
}

const TEXT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown', 'csv', 'log', 'json', 'xml']);
const HTML_EXTENSIONS = new Set(['html', 'htm', 'xhtml']);
const DOCX_EXTENSIONS = new Set(['docx', 'doc']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an uploaded document (Base64 + filename) into Markdown.
 *
 * - `.pdf`        → `pdf-parse` text extraction
 * - `.docx`/`.doc`→ `mammoth` → HTML → Markdown
 * - `.html`/`.htm`→ `extractFromHtml` (Readability) → Markdown
 * - `.txt`/`.md`  → verbatim passthrough
 * - anything else → best-effort UTF-8 passthrough
 */
export async function toMarkdown({ base64, filename }: MarkdownInput): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const ext = extensionOf(filename);

  if (ext === 'pdf') {
    const parsed = await pdfParse(buffer);
    return tidyText(parsed.text ?? '');
  }

  if (DOCX_EXTENSIONS.has(ext)) {
    const { value } = await mammoth.convertToHtml({ buffer });
    return htmlToMarkdown(value);
  }

  if (HTML_EXTENSIONS.has(ext)) {
    return extractFromHtml(buffer.toString('utf8')).markdown;
  }

  if (TEXT_EXTENSIONS.has(ext) || ext === '') {
    return tidyText(buffer.toString('utf8'));
  }

  // Unknown extension: still return something useful rather than failing.
  return tidyText(buffer.toString('utf8'));
}
