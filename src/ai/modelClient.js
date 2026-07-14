export const DEFAULT_SYSTEM_PROMPT = `你是 Paper Graph 内的研究助手。
你可以使用工具读取当前对话文件、解析 PDF、搜索文件、创建文本文件、联网搜索、读取明确网页和解析 DOI 元数据。
图谱工具按需读取节点细节；当需要读取多个已知节点时优先调用 get_graph_nodes，一次传入 node_ids，不要逐个重复调用 get_graph_node。
需要文件信息时先调用 list_workspace；不要编造文件内容或搜索结果。引用 PDF 时标注页码。
联网搜索结果包含 citation 字段，例如 [S1]。使用搜索结果支持结论时，必须在相应句子后原样写出该 citation；不要杜撰不存在的引用编号，也不要把 citation 改写为 Markdown 链接。
联网搜索一次会同时检索百科与学术文献。只有当 DOI 原样出现在用户消息或工具结果中时才可使用 resolve_doi，绝对不要根据标题、作者或记忆猜测 DOI；DOI 未找到时不要重复解析，应改用标题/作者搜索或已有网页，并继续基于现有信息回答。已有明确 URL 时使用 open_url，不要通过改写关键词反复寻找同一页面。web_search 返回 no_new_results 时不得再次调用 web_search；应基于已有来源完成回答并说明不确定性，仅可用已有的明确 URL/DOI 做一次精确补充。`;

export async function runAgentTurn({ config, history, userText, tools, onDelta, onReasoningDelta, signal }) {
  validateConfig(config);
  const messages = [
    { role: 'system', content: [config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT, config.contextPrompt?.trim()].filter(Boolean).join('\n\n') },
    ...history.filter((m) => m.role === 'user' || m.role === 'assistant').map(({ role, content }) => ({ role, content })),
    { role: 'user', content: userText },
  ];
  let collected = '';
  let webSearchDisabled = false;

  while (true) {
    const availableTools = webSearchDisabled
      ? tools.definitions.filter((definition) => definition.function?.name !== 'web_search')
      : tools.definitions;
    const response = await streamCompletion(config, messages, availableTools, (delta) => {
      collected += delta;
      onDelta?.(delta);
    }, onReasoningDelta, signal);

    if (!response.toolCalls.length) return collected || response.content;

    tools.beginBatch?.(response.toolCalls);

    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments || '{}' },
      })),
    });

    for (const call of response.toolCalls) {
      let output;
      try {
        output = await tools.execute({ id: call.id, function: { name: call.name, arguments: call.arguments || '{}' } });
      } catch (error) {
        output = JSON.stringify({ error: error?.message || String(error) });
      }
      try {
        if (JSON.parse(output)?.no_new_results) webSearchDisabled = true;
      } catch { /* tool output may be plain text */ }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
  }
}

export async function streamCompletion(config, messages, tools, onDelta, onReasoningDelta, signal) {
  if (config.protocol === 'anthropic-messages') return streamAnthropic(config, messages, tools, onDelta, onReasoningDelta, signal);
  if (config.protocol === 'gemini') return streamGemini(config, messages, tools, onDelta, onReasoningDelta, signal);
  return streamOpenAi(config, messages, tools, onDelta, onReasoningDelta, signal);
}

async function streamOpenAi(config, messages, tools, onDelta, onReasoningDelta, signal) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model: config.model, messages, tools, tool_choice: 'auto', stream: true }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`模型请求失败（${response.status}）：${detail.slice(0, 500)}`);
  }
  if (!response.body) throw new Error('模型响应不支持流式读取');

  const decoder = new SseDecoder();
  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const toolCalls = new Map();
  let content = '';

  const consume = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    const delta = event.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content) { content += delta.content; onDelta?.(delta.content); }
    if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (part?.type === 'text' && part.text) { content += part.text; onDelta?.(part.text); }
        else if ((part?.type === 'reasoning' || part?.type === 'thinking') && (part.text || part.thinking)) onReasoningDelta?.(part.text || part.thinking);
      }
    }
    const reasoning = readReasoningDelta(delta);
    if (reasoning) onReasoningDelta?.(reasoning);
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      const current = toolCalls.get(index) || { id: '', name: '', arguments: '' };
      if (part.id) current.id += part.id;
      if (part.function?.name) current.name += part.function.name;
      if (part.function?.arguments) current.arguments += part.function.arguments;
      toolCalls.set(index, current);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const payload of decoder.push(textDecoder.decode(value, { stream: true }))) consume(payload);
  }
  for (const payload of decoder.push(textDecoder.decode(), true)) consume(payload);
  return { content, toolCalls: [...toolCalls.values()].filter((call) => call.name) };
}

async function streamAnthropic(config, messages, tools, onDelta, onReasoningDelta, signal) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const response = await fetch(`${base}/messages`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify({ model: config.model, max_tokens: 8192, system, messages: toAnthropicMessages(messages), tools: toAnthropicTools(tools), stream: true }),
  });
  await ensureResponse(response);
  const content = { text: '' };
  const toolCalls = new Map();
  await consumeSse(response, (event) => {
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      toolCalls.set(event.index, { id: event.content_block.id, name: event.content_block.name, arguments: '' });
    }
    const delta = event.delta || {};
    if (delta.type === 'text_delta' && delta.text) { content.text += delta.text; onDelta?.(delta.text); }
    if (delta.type === 'thinking_delta' && delta.thinking) onReasoningDelta?.(delta.thinking);
    if (delta.type === 'input_json_delta') {
      const current = toolCalls.get(event.index);
      if (current) current.arguments += delta.partial_json || '';
    }
  });
  return { content: content.text, toolCalls: [...toolCalls.values()].map((call) => ({ ...call, arguments: call.arguments || '{}' })) };
}

async function streamGemini(config, messages, tools, onDelta, onReasoningDelta, signal) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const model = String(config.model).replace(/^models\//, '');
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const response = await fetch(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      contents: toGeminiContents(messages),
      tools: tools.length ? [{ functionDeclarations: tools.map((item) => ({ name: item.function.name, description: item.function.description, parameters: item.function.parameters })) }] : undefined,
    }),
  });
  await ensureResponse(response);
  let content = '';
  const toolCalls = [];
  await consumeSse(response, (event) => {
    for (const part of event.candidates?.[0]?.content?.parts || []) {
      if (part.text) {
        if (part.thought) onReasoningDelta?.(part.text);
        else { content += part.text; onDelta?.(part.text); }
      }
      if (part.functionCall) toolCalls.push({ id: `gemini-${Date.now()}-${toolCalls.length}`, name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) });
    }
  });
  return { content, toolCalls };
}

export function toAnthropicMessages(messages) {
  const output = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content || '') };
      if (output.at(-1)?.role === 'user' && Array.isArray(output.at(-1).content) && output.at(-1).content.every((item) => item.type === 'tool_result')) output.at(-1).content.push(block);
      else output.push({ role: 'user', content: [block] });
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.tool_calls) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: safeJson(call.function.arguments) });
      output.push({ role: 'assistant', content });
    } else output.push({ role: message.role, content: String(message.content || '') });
  }
  return output;
}

export function toGeminiContents(messages) {
  const callNames = new Map();
  const output = [];
  for (const message of messages.filter((item) => item.role !== 'system')) {
    let role = message.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (message.role === 'assistant') {
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls || []) {
        callNames.set(call.id, call.function.name);
        parts.push({ functionCall: { name: call.function.name, args: safeJson(call.function.arguments) } });
      }
    } else if (message.role === 'tool') {
      role = 'user';
      parts.push({ functionResponse: { name: callNames.get(message.tool_call_id) || 'tool', response: safeJson(message.content) } });
    } else parts.push({ text: String(message.content || '') });
    if (output.at(-1)?.role === role && message.role === 'tool') output.at(-1).parts.push(...parts);
    else output.push({ role, parts });
  }
  return output;
}

function toAnthropicTools(tools) { return tools.map((item) => ({ name: item.function.name, description: item.function.description, input_schema: item.function.parameters })); }
function safeJson(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return { content: String(value || '') }; } }
async function ensureResponse(response) {
  if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${(await response.text()).slice(0, 500)}`);
  if (!response.body) throw new Error('模型响应不支持流式读取');
}
async function consumeSse(response, onEvent) {
  const decoder = new SseDecoder();
  const reader = response.body.getReader();
  const textDecoder = new TextDecoder();
  const consume = (payload) => { if (payload && payload !== '[DONE]') { try { onEvent(JSON.parse(payload)); } catch { /* ignore malformed event */ } } };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    decoder.push(textDecoder.decode(value, { stream: true })).forEach(consume);
  }
  decoder.push(textDecoder.decode(), true).forEach(consume);
}

export function readReasoningDelta(delta) {
  for (const value of [delta?.reasoning_content, delta?.reasoning, delta?.thinking]) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

export class SseDecoder {
  constructor() { this.buffer = ''; }

  push(chunk, flush = false) {
    this.buffer += chunk;
    const events = [];
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    const remainder = blocks.pop() || '';
    if (flush && remainder.trim()) blocks.push(remainder);
    this.buffer = flush ? '' : remainder;
    for (const block of blocks) {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) events.push(data);
    }
    return events;
  }
}

function validateConfig(config) {
  if (!config?.baseUrl) throw new Error('请先配置模型 Base URL');
  if (!config?.model) throw new Error('请先配置模型名称');
  if (!config?.apiKey) throw new Error('请先填写 API Key（仅保存在当前浏览器会话）');
}
