export function appendTextBlock(message, text) {
  if (!text) return null;
  message.blocks ||= [];
  let block = message.blocks.at(-1);
  if (!block || block.type !== 'text') {
    block = { type: 'text', content: '' };
    message.blocks.push(block);
  }
  block.content += text;
  return block;
}

export function appendReasoningBlock(message, text) {
  if (!text) return null;
  message.blocks ||= [];
  let block = message.blocks.at(-1);
  if (!block || block.type !== 'reasoning') {
    block = { type: 'reasoning', content: '' };
    message.blocks.push(block);
  }
  block.content += text;
  return block;
}

export function upsertToolBlock(message, event, status) {
  message.blocks ||= [];
  const key = event.id || `${event.name}-${message.blocks.length}`;
  let block = message.blocks.find((item) => item.type === 'tool' && item.key === key);
  if (!block) {
    block = { type: 'tool', key, name: event.name, args: event.args, status: 'running', batch: event.batch };
    message.blocks.push(block);
  }
  block.status = status;
  if (event.result) block.result = event.result;
  if (event.error) block.error = event.error?.message || String(event.error);
  return block;
}

export function mergeToolSources(message, event) {
  if (!['web_search', 'open_url', 'resolve_doi'].includes(event.name) || !event.result?.results) return;
  message.sources ||= [];
  const known = new Set(message.sources.map((source) => source.citation));
  for (const result of event.result.results) {
    if (!result.citation || known.has(result.citation)) continue;
    message.sources.push({
      citation: result.citation,
      title: result.title,
      url: result.url,
      excerpt: result.excerpt,
      provider: result.provider || event.result.provider,
    });
    known.add(result.citation);
  }
}

export function messageBlocks(message) {
  if (Array.isArray(message.blocks) && message.blocks.length) return message.blocks;
  const legacy = (message.events || []).map((event, index) => ({ type: 'tool', key: event.key || `legacy-${index}`, ...event }));
  if (message.content) legacy.push({ type: 'text', content: message.content });
  return legacy;
}

export function serializeMessageDebug(message, { index } = {}) {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'user' ? 'user' : message.role || 'unknown';
  const lines = [`# Message${Number.isInteger(index) ? ` ${index + 1}` : ''}`, `role: ${role}`];
  if (message.createdAt) lines.push(`created_at: ${message.createdAt}`);

  const blocks = role === 'assistant' ? messageBlocks(message) : [{ type: 'text', content: message.content || '' }];
  blocks.forEach((block, blockIndex) => {
    lines.push('', `## Block ${blockIndex + 1}: ${block.type}`);
    if (block.type === 'text' || block.type === 'reasoning') {
      lines.push(block.content || '');
      return;
    }
    if (block.type === 'tool') {
      lines.push(`name: ${block.name || ''}`, `status: ${block.status || ''}`, `call_id: ${block.key || ''}`);
      lines.push('', '### Arguments', stringify(block.args));
      if (block.error) lines.push('', '### Error', String(block.error));
      if (block.result !== undefined) lines.push('', '### Result', stringify(block.result));
    }
  });

  if (message.sources?.length) {
    lines.push('', '## Sources');
    for (const source of message.sources) {
      lines.push(`${source.citation || '-'} ${source.title || source.url || ''}`, source.url || '', source.excerpt || '');
    }
  }
  return lines.join('\n').trim();
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? null, null, 2); }
  catch { return String(value); }
}
