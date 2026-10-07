/**
 * Minimal YAML subset parser — just enough for `evals/tasks/*.yaml`.
 *
 * Supported (and nothing more):
 *   key: scalar
 *   key:                       -> a list of the following `- item` lines
 *     - scalar
 *     - nested_key: scalar
 *   # comments (whole-line), blank lines, single/double quoted scalars,
 *   true/false/null, integers.
 *
 * This deliberately avoids a dependency. The task files are authored by this
 * repo, so the subset is exact — if a file needs more YAML than this, the
 * parser throws instead of guessing.
 */
export function parseScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text === '[]') return [];
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function splitKeyValue(line) {
  const match = /^([A-Za-z0-9_-]+)\s*:\s?(.*)$/.exec(line);
  if (!match) return null;
  return { key: match[1], value: match[2] };
}

export function parseYaml(source) {
  const root = {};
  let currentList = null;

  for (const rawLine of String(source).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const listMatch = /^-\s+(.*)$/.exec(line);
    if (listMatch) {
      if (!currentList) throw new Error(`list item without a key: ${line}`);
      const body = listMatch[1].trim();
      const kv = splitKeyValue(body);
      currentList.push(kv ? { [kv.key]: parseScalar(kv.value) } : parseScalar(body));
      continue;
    }

    const kv = splitKeyValue(line);
    if (!kv) throw new Error(`unsupported YAML line: ${line}`);

    if (kv.value === '') {
      currentList = [];
      root[kv.key] = currentList;
    } else if (kv.value === '[]') {
      root[kv.key] = [];
      currentList = null;
    } else {
      root[kv.key] = parseScalar(kv.value);
      currentList = null;
    }
  }

  return root;
}

export function parseTaskFile(source, filename = '<task>') {
  const trimmed = String(source).trimStart();
  const data = trimmed.startsWith('{') ? JSON.parse(source) : parseYaml(source);

  if (!data.id || typeof data.id !== 'string') throw new Error(`${filename}: missing id`);
  if (!data.prompt || typeof data.prompt !== 'string') throw new Error(`${filename}: missing prompt`);
  if (!Array.isArray(data.expect) || data.expect.length === 0) {
    throw new Error(`${filename}: expect must be a non-empty list`);
  }
  if (typeof data.weight !== 'number') throw new Error(`${filename}: weight must be a number`);

  return {
    id: data.id,
    prompt: data.prompt,
    fixture: typeof data.fixture === 'string' ? data.fixture : 'simple-page',
    expect: data.expect,
    weight: data.weight,
    notes: typeof data.notes === 'string' ? data.notes : '',
  };
}

export default parseTaskFile;
