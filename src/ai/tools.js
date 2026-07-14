const TEXT_EXT = /\.(txt|md|tex|json|csv|js|mjs|ts|css|html|xml|yaml|yml)$/i;
import { executeGraphTool, graphToolDefinitions, isGraphTool } from './graphContext.js';

export function createClientTools(workspace, hooks = {}) {
  let sourceNumber = 0;
  let toolBatchNumber = 0;
  let overlapStreak = 0;
  let searchConverged = false;
  const knownSources = new Map();
  for (const source of hooks.initialSources || []) {
    const key = canonicalSourceKey(source);
    if (key && !knownSources.has(key)) knownSources.set(key, source);
    const number = /^\[S(\d+)\]$/.exec(source.citation || '')?.[1];
    if (number) sourceNumber = Math.max(sourceNumber, Number(number));
  }
  const definitions = [
    tool('list_workspace', '列出当前对话中的本地文件。', {
      type: 'object', properties: {}, additionalProperties: false,
    }),
    tool('read_file', '读取当前对话中的文本文件。适合 TXT、Markdown、TeX、JSON 和代码文件。', {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'list_workspace 返回的相对路径' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 50000, description: '最多返回字符数' },
      },
    }),
    tool('search_files', '在当前对话的文本文件中搜索关键词。', {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: {
        query: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 30 },
      },
    }),
    tool('read_pdf', '提取当前对话 PDF 的文本，并保留页码。', {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: {
        path: { type: 'string' },
        max_pages: { type: 'integer', minimum: 1, maximum: 80 },
        max_chars: { type: 'integer', minimum: 2000, maximum: 60000 },
      },
    }),
    tool('write_file', '在当前对话创建或覆盖本地文本文件。执行前需要用户确认。', {
      type: 'object', required: ['path', 'content'], additionalProperties: false,
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    }),
    tool('web_search', '搜索网页与公开学术文献索引。根据任务需要检索，避免只用近义词重复搜索同一问题。', {
      type: 'object', required: ['query'], additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 8 },
      },
    }),
    tool('open_url', '读取一个明确的公开网页 URL，返回适合分析的正文。已有 URL 时使用本工具，不要继续用 web_search 搜索同一页面。', {
      type: 'object', required: ['url'], additionalProperties: false,
      properties: {
        url: { type: 'string', description: '需要读取的公开 HTTP(S) URL' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 30000, description: '最多返回字符数' },
      },
    }),
    tool('resolve_doi', '仅对用户消息或 web_search 结果中明确出现的 DOI 精确获取论文元数据；不要猜测、改写或凭标题生成 DOI。若 DOI 不存在，工具会返回未找到状态，此时改用标题/作者搜索并继续回答。', {
      type: 'object', required: ['doi'], additionalProperties: false,
      properties: { doi: { type: 'string', description: 'DOI 或 https://doi.org/ URL' } },
    }),
    ...(hooks.graphModel ? graphToolDefinitions() : []),
  ];

  function registerSource(item) {
    const normalized = normalizeSource(item);
    const key = canonicalSourceKey(normalized);
    if (!key) return { source: normalized, isNew: false };
    const existing = knownSources.get(key);
    if (existing) return { source: { ...normalized, citation: existing.citation }, isNew: false };
    const source = { ...normalized, citation: `[S${++sourceNumber}]`, canonicalKey: key };
    knownSources.set(key, source);
    return { source, isNew: true };
  }

  function beginBatch(calls) {
    const batch = ++toolBatchNumber;
    for (const call of calls || []) {
      const name = call.function?.name || call.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || call.arguments || '{}'); } catch { /* execute reports malformed arguments */ }
      hooks.onQueued?.({ id: call.id, name, args, batch });
    }
  }

  async function execute(call) {
    const name = call.function?.name || call.name;
    let args;
    try { args = JSON.parse(call.function?.arguments || call.arguments || '{}'); }
    catch { throw new Error(`工具 ${name} 的参数不是有效 JSON`); }
    hooks.onStart?.({ id: call.id, name, args });
    try {
      let result;
      if (name === 'list_workspace') result = await listWorkspace(workspace);
      else if (name === 'read_file') result = await readTextFile(workspace, args);
      else if (name === 'search_files') result = await searchFiles(workspace, args);
      else if (name === 'read_pdf') result = await readPdf(workspace, args);
      else if (name === 'write_file') result = await writeFile(workspace, args, hooks.confirm);
      else if (name === 'web_search') {
        if (searchConverged) {
          result = convergedSearchResult(args.query, overlapStreak);
        } else {
          result = await webSearch(args);
          const current = uniqueSources(result.results);
          const added = [];
          const reused = [];
          for (const item of current) {
            const registered = registerSource(item);
            (registered.isNew ? added : reused).push(registered.source);
          }
          const overlapRatio = current.length ? reused.length / current.length : 1;
          const lowProgress = !added.length || overlapRatio >= 2 / 3;
          overlapStreak = lowProgress ? overlapStreak + 1 : 0;
          searchConverged = overlapStreak >= 2;
          result = {
            ...result,
            status: searchConverged ? 'no_new_results' : 'ok',
            no_new_results: searchConverged,
            results: added,
            reused_sources: reused.slice(0, 8),
            search_progress: {
              returned: current.length,
              new_sources: added.length,
              repeated_sources: reused.length,
              overlap_ratio: Number(overlapRatio.toFixed(2)),
              no_progress_streak: overlapStreak,
            },
            ...(searchConverged ? convergenceInstruction() : {}),
          };
        }
      }
      else if (name === 'open_url') result = await openUrl(args, registerSource);
      else if (name === 'resolve_doi') result = await resolveDoi(args, registerSource);
      else if (hooks.graphModel && isGraphTool(name)) result = await executeGraphTool(hooks.graphModel, name, args, hooks);
      else throw new Error(`未知工具：${name}`);
      hooks.onEnd?.({ id: call.id, name, args, result });
      return JSON.stringify(result);
    } catch (error) {
      hooks.onError?.({ id: call.id, name, args, error });
      throw error;
    }
  }

  return { definitions, beginBatch, execute };
}

async function listWorkspace(workspace) {
  const files = await workspace.listFiles();
  return { files: files.map(({ path, size, type }) => ({ path, size, type })) };
}

async function readTextFile(workspace, args) {
  if (!TEXT_EXT.test(args.path || '')) throw new Error('该文件类型不适合作为文本读取');
  const file = await workspace.readFile(args.path);
  const max = clamp(args.max_chars, 1000, 50000, 24000);
  const text = await file.text();
  return { path: args.path, content: text.slice(0, max), truncated: text.length > max };
}

async function searchFiles(workspace, args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('搜索词不能为空');
  const limit = clamp(args.max_results, 1, 30, 12);
  const files = (await workspace.listFiles()).filter((item) => TEXT_EXT.test(item.path));
  const results = [];
  for (const item of files) {
    const text = await (await workspace.readFile(item.path)).text();
    const lower = text.toLowerCase();
    let from = 0;
    while (results.length < limit) {
      const index = lower.indexOf(query.toLowerCase(), from);
      if (index < 0) break;
      results.push({ path: item.path, excerpt: text.slice(Math.max(0, index - 100), index + query.length + 180) });
      from = index + query.length;
    }
    if (results.length >= limit) break;
  }
  return { query, results };
}

async function readPdf(workspace, args) {
  if (!/\.pdf$/i.test(args.path || '')) throw new Error('请选择 PDF 文件');
  const maxPages = clamp(args.max_pages, 1, 80, 30);
  const maxChars = clamp(args.max_chars, 2000, 60000, 32000);
  const { extractPdfText } = await import('./pdf.js');
  const parsed = await extractPdfText(await workspace.readFile(args.path), { maxPages });
  let used = 0;
  const pages = [];
  for (const page of parsed.pages) {
    if (used >= maxChars) break;
    const text = page.text.slice(0, maxChars - used);
    pages.push({ page: page.page, text });
    used += text.length;
  }
  return { path: args.path, pageCount: parsed.pageCount, pages, truncated: parsed.truncated || pages.length < parsed.pages.length };
}

async function writeFile(workspace, args, confirm) {
  const path = String(args.path || '').trim();
  const content = String(args.content ?? '');
  const allowed = confirm ? await confirm({ name: 'write_file', path, preview: content.slice(0, 600) }) : false;
  if (!allowed) return { path, written: false, reason: '用户拒绝写入' };
  await workspace.writeFile(path, content);
  return { path, written: true, chars: content.length };
}

async function webSearch(args) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('搜索词不能为空');
  const limit = clamp(args.limit, 1, 8, 5);
  const perSource = Math.max(2, Math.ceil(limit / 2));
  const settled = await Promise.allSettled([
    searchWikipedia(query, perSource),
    searchCrossref(query, perSource),
  ]);
  const results = settled.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : []);
  if (!results.length && settled.every((entry) => entry.status === 'rejected')) {
    throw new Error(`搜索失败：${settled.map((entry) => entry.reason?.message).filter(Boolean).join('；')}`);
  }
  const seen = new Set();
  return {
    query,
    provider: 'Web',
    results: results.filter((item) => {
      const key = item.url?.replace(/\/$/, '').toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit),
  };
}

function convergedSearchResult(query, streak) {
  return {
    query: String(query || '').trim(),
    provider: 'Web',
    status: 'no_new_results',
    no_new_results: true,
    results: [],
    reused_sources: [],
    search_progress: { returned: 0, new_sources: 0, repeated_sources: 0, overlap_ratio: 1, no_progress_streak: streak },
    ...convergenceInstruction(),
  };
}

function convergenceInstruction() {
  return {
    reason: '连续搜索没有获得足够的新来源，已停止本轮继续改写关键词搜索。',
    instruction: '不要再次调用 web_search。请基于已有来源完成回答并明确说明不确定性；仅当已有明确 URL 或 DOI 且确需补充页面或元数据时，可调用 open_url 或 resolve_doi。',
  };
}

async function openUrl(args, registerSource) {
  const target = publicHttpUrl(args.url);
  const maxChars = clamp(args.max_chars, 1000, 30000, 12000);
  const readerUrl = `https://r.jina.ai/${target.href}`;
  const response = await fetch(readerUrl, { headers: { Accept: 'text/plain' } });
  if (!response.ok) throw new Error(`网页读取失败（HTTP ${response.status}）`);
  const fullContent = await response.text();
  const title = /^Title:\s*(.+)$/mi.exec(fullContent)?.[1]?.trim() || target.hostname;
  const excerpt = fullContent.replace(/^Title:.*$/mi, '').trim().slice(0, 500);
  const registered = registerSource({ title, url: target.href, excerpt, provider: 'Web page' });
  return {
    url: target.href,
    title,
    citation: registered.source.citation,
    content: fullContent.slice(0, maxChars),
    truncated: fullContent.length > maxChars,
    results: [registered.source],
  };
}

async function resolveDoi(args, registerSource) {
  const doi = extractDoi(args.doi);
  if (!doi) throw new Error('请输入有效 DOI，例如 10.1090/cams/50');
  const path = doi.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://api.crossref.org/works/${path}`, { headers: { Accept: 'application/json' } });
  if (response.status === 404) {
    return {
      status: 'not_found',
      doi,
      provider: 'Crossref',
      message: 'Crossref 中未找到该 DOI 的元数据。请不要重复解析这个 DOI，可改用论文标题、作者或明确网页继续检索。',
      results: [],
    };
  }
  if (!response.ok) throw new Error(`DOI 元数据读取失败（Crossref HTTP ${response.status}）`);
  const item = (await response.json()).message || {};
  const authors = (item.author || []).map((author) => ({
    name: [author.given, author.family].filter(Boolean).join(' '),
    given: author.given || '',
    family: author.family || '',
    orcid: author.ORCID || '',
    affiliation: (author.affiliation || []).map((entry) => entry.name).filter(Boolean),
  })).filter((author) => author.name);
  const date = item.published?.['date-parts']?.[0] || item.issued?.['date-parts']?.[0] || [];
  const url = `https://doi.org/${doi}`;
  const title = item.title?.[0] || doi;
  const excerpt = stripHtml(item.abstract || [authors.map((author) => author.name).join(', '), item['container-title']?.[0], date[0]].filter(Boolean).join(' · '));
  const registered = registerSource({ title, url, doi, excerpt, provider: 'Crossref' });
  return {
    doi,
    title,
    authors,
    container_title: item['container-title']?.[0] || '',
    published: date,
    publisher: item.publisher || '',
    type: item.type || '',
    abstract: stripHtml(item.abstract || ''),
    url,
    citation: registered.source.citation,
    results: [registered.source],
  };
}

async function searchWikipedia(query, limit) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, format: 'json', origin: '*', srlimit: String(limit) });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`);
  const data = await response.json();
  return (data.query?.search || []).map((item) => ({
    title: item.title,
    excerpt: stripHtml(item.snippet),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
    provider: 'Wikipedia',
  }));
}

async function searchCrossref(query, limit) {
  const url = new URL('https://api.crossref.org/works');
  url.search = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(limit),
    select: 'DOI,title,author,published,URL,container-title,abstract',
  });
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
  const data = await response.json();
  return (data.message?.items || []).map((item) => {
    const authors = (item.author || []).slice(0, 3).map((author) => [author.given, author.family].filter(Boolean).join(' ')).filter(Boolean);
    const year = item.published?.['date-parts']?.[0]?.[0];
    const venue = item['container-title']?.[0];
    const metadata = [authors.join(', '), venue, year].filter(Boolean).join(' · ');
    return {
      title: item.title?.[0] || item.DOI || 'Untitled work',
      excerpt: stripHtml(item.abstract || metadata),
      url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
      doi: item.DOI || '',
      provider: 'Crossref',
    };
  }).filter((item) => item.url);
}

export function canonicalSourceKey(source) {
  const doi = extractDoi(source?.doi || source?.url || '');
  if (doi) return `doi:${doi}`;
  try {
    const url = new URL(source?.url || source);
    if (!/^https?:$/.test(url.protocol)) return '';
    url.hash = '';
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|ref|source)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `url:${url.hostname.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return '';
  }
}

export function extractDoi(value) {
  let text = String(value || '').trim();
  try {
    const url = new URL(text);
    if (/^(dx\.)?doi\.org$/i.test(url.hostname)) text = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch { /* DOI may not be a URL */ }
  const match = /10\.\d{4,9}\/[^\s?#]+/i.exec(text);
  return match ? match[0].replace(/[\/.,;:)}\]]+$/, '').toLowerCase() : '';
}

function normalizeSource(source) {
  const doi = extractDoi(source?.doi || source?.url || '');
  return {
    ...source,
    ...(doi ? { doi, url: `https://doi.org/${doi}` } : {}),
  };
}

function uniqueSources(results) {
  const seen = new Set();
  return (results || []).filter((item) => {
    const key = canonicalSourceKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('URL 格式无效'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('仅支持不含凭据的 HTTP(S) URL');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host === '::1'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('不允许读取本机或私有网络地址');
  }
  url.hash = '';
  return url;
}

function tool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&');
}
