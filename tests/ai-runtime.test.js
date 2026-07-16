import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT, isRetryableStreamError, readReasoningDelta, runAgentTurn, SseDecoder } from '../src/ai/modelClient.js';
import { normalizeWorkspacePath } from '../src/ai/workspace.js';
import { appendReasoningBlock, appendTextBlock, messageBlocks, serializeMessageDebug, upsertToolBlock } from '../src/ai/messageBlocks.js';
import { canonicalSourceKey, createClientTools, extractDoi } from '../src/ai/tools.js';
import {
  aiQuoteAttachment, contextPrompt, fileExcerptAttachment, graphNodeAttachment, graphSelectionAttachment, mentionQueryAt, pdfFieldAttachment, replaceMention, searchMentionCandidates,
} from '../src/ai/contextAttachments.js';
import { formatGraphReferenceDisplay, normalizeCjkStrong, protectMarkdownMath, stripBlockquoteMathMarkers } from '../src/render/markdown.js';
import { activityTimelineEntries, applyCloudTaskSnapshot, deletedWorkspacePaths, isActivityGroupActive, isScrollNearBottom, navigateGraphReference, normalizeAiText, noteFromAssistantMessage, noteFromWorkspaceMarkdown, reconcileCloudWorkspaceChanges, replaceUserMessageBranch, shouldJoinActivityBlock, shouldSyncWorkspaceAfterTask } from '../src/ui/aiPanel.js';

afterEach(() => vi.unstubAllGlobals());

describe('AI runtime helpers', () => {
  it('normalizes only actual AI text before submission', () => {
    expect(normalizeAiText('  真实问题  ')).toBe('真实问题');
    expect(normalizeAiText(null)).toBe('');
  });

  it('applies incremental cloud answer and activity snapshots without duplicating text', () => {
    const message = { role: 'assistant', content: '', blocks: [] };
    applyCloudTaskSnapshot(message, {
      output: '逐步回答',
      blocks: [{ type: 'reasoning', content: '推理摘要' }, { type: 'text', content: '逐步回答' }],
      workspaceChanges: { committed: true, modified: ['notes/result.md'] },
    });
    expect(message.content).toBe('逐步回答');
    expect(message.blocks).toEqual([{ type: 'reasoning', content: '推理摘要' }, { type: 'text', content: '逐步回答' }]);
    expect(message.workspaceChanges).toEqual({ committed: true, modified: ['notes/result.md'] });
  });

  it('refreshes the local workspace after completed cloud tasks and applies committed deletions', () => {
    const task = {
      status: 'completed',
      workspaceChanges: { deleted: ['notes\\old.md', '/uploads/removed.pdf', 'notes/old.md'] },
    };
    expect(shouldSyncWorkspaceAfterTask(task)).toBe(true);
    expect(shouldSyncWorkspaceAfterTask({ status: 'running' })).toBe(false);
    expect(deletedWorkspacePaths(task)).toEqual(['notes/old.md', 'uploads/removed.pdf']);
  });

  it('force-pulls task-created and modified files before timestamp-based workspace sync', async () => {
    const workspace = {
      deleteFile: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
    };
    const api = {
      getFile: vi.fn(async (_scope, filePath) => ({
        file: {
          path: filePath,
          type: 'text/markdown',
          data: btoa(filePath === 'created.md' ? 'created content' : 'remote Codex version'),
        },
      })),
    };
    const result = await reconcileCloudWorkspaceChanges(workspace, 'scope', {
      created: ['created.md'],
      modified: ['md-test.md'],
      deleted: ['old.md'],
    }, api);
    expect(result).toEqual({ pulled: ['created.md', 'md-test.md'], deleted: ['old.md'] });
    expect(workspace.deleteFile).toHaveBeenCalledWith('old.md');
    expect(api.getFile).toHaveBeenCalledTimes(2);
    expect(workspace.writeFile).toHaveBeenCalledTimes(2);
    expect(await workspace.writeFile.mock.calls[1][1].text()).toBe('remote Codex version');
  });

  it('builds structured graph selection context with node location and surrounding text', () => {
    const node = { id: 'lem:appell', number: 'Lemma 4.2', title: 'Appell 变换', statementBody: '前文内容 关键结论 后文内容', x: 12.34, y: 56.78 };
    const model = { nodes: [node], nodeById: new Map([[node.id, node]]) };
    const attachment = graphSelectionAttachment(model, { node: node.id, section: 'statement', start: 5, end: 9, text: '关键结论' });
    const prompt = contextPrompt('解释这一段', [attachment], model);
    expect(prompt).toContain('node_id：lem:appell');
    expect(prompt).toContain('图谱位置：全局第 1 个节点');
    expect(prompt).toContain('<selected_text>\n关键结论\n</selected_text>');
    expect(prompt).toContain('选中内容是本次问题的唯一主要解释对象');
    expect(prompt).toContain('不要调用 get_graph_node');
    expect(prompt).toContain('<disambiguation_context>');
    expect(prompt).not.toContain('如需核对完整内容');
  });

  it('finds and replaces live @ mentions for graph nodes and files', () => {
    const node = { id: 'thm:ucp', number: '定理 2.1', title: '唯一延拓性', importance: 3 };
    const model = { nodes: [node], nodeById: new Map([[node.id, node]]) };
    const mention = mentionQueryAt('请比较 @唯一', 7);
    expect(mention?.query).toBe('唯一');
    const candidates = searchMentionCandidates(model, [{ name: 'ucp.pdf', path: 'uploads/ucp.pdf' }], 'ucp');
    expect(candidates.map((item) => item.kind)).toEqual(expect.arrayContaining(['node', 'file']));
    expect(graphNodeAttachment(model, node.id).id).toBe('node:thm:ucp');
    expect(replaceMention('请比较 @唯一', mention, '定理 2.1').value).toBe('请比较 @定理 2.1 ');
  });

  it('scopes an AI response quote to only the selected fragment', () => {
    const message = { role: 'assistant', content: '前文说明。需要引用的关键结论。后文说明。', createdAt: '2026-07-14T00:00:00.000Z' };
    const attachment = aiQuoteAttachment(message, 3, '需要引用的关键结论', '测试对话');
    const prompt = contextPrompt('这里是什么意思？', [attachment], null);
    expect(attachment.kind).toBe('ai-quote');
    expect(prompt).toContain('<quoted_text>\n需要引用的关键结论\n</quoted_text>');
    expect(prompt).toContain('不要重新概述整条回复');
    expect(prompt).toContain('前文：前文说明。');
    expect(prompt).toContain('后文：。后文说明。');
  });

  it('creates a conversation-scoped PDF field reference with page position', () => {
    const attachment = pdfFieldAttachment({
      path: 'uploads/paper.pdf',
      name: 'paper.pdf',
      page: 7,
      text: 'Selected theorem statement',
      rects: [{ x: 0.12, y: 0.34, width: 0.5, height: 0.04 }],
      conversationId: 'chat-1',
    });
    const prompt = contextPrompt('解释这个字段', [attachment], null);
    expect(attachment).toMatchObject({ kind: 'file-fragment', format: 'pdf', page: 7, conversationId: 'chat-1' });
    expect(prompt).toContain('[文件片段引用]');
    expect(prompt).toContain('页码：7');
    expect(prompt).toContain('引用链接：[');
    expect(prompt).toContain('<selected_text>\nSelected theorem statement\n</selected_text>');
    expect(prompt).toContain('PDF 字段引用中的 selected_text 是本次问题的主要解释对象');
  });

  it('creates a scoped Markdown or TXT excerpt reference', () => {
    const attachment = fileExcerptAttachment({
      path: 'notes/readme.md',
      name: 'readme.md',
      text: 'Selected paragraph',
      before: 'Earlier context. ',
      after: ' Later context.',
      conversationId: 'chat-1',
    });
    const prompt = contextPrompt('解释这个片段', [attachment], null);
    expect(attachment).toMatchObject({ kind: 'file-fragment', format: 'markdown', path: 'notes/readme.md', conversationId: 'chat-1' });
    expect(prompt).toContain('[文件片段引用]');
    expect(prompt).toContain('<selected_text>\nSelected paragraph\n</selected_text>');
    expect(prompt).toContain('前文：Earlier context.');
    expect(prompt).toContain('引用链接：[');
    expect(prompt).toContain('不要再次读取完整文件');
  });

  it('turns a Markdown workspace file into a floating note', () => {
    const note = noteFromWorkspaceMarkdown(
      { path: 'notes/research.md', name: 'research.md', text: '# Result\n\nImportant.' },
      { id: 'note-md', now: '2026-07-16T00:00:00.000Z' },
    );
    expect(note).toEqual({
      id: 'note-md',
      title: 'research',
      content: '# Result\n\nImportant.',
      tagPointer: null,
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
  });

  it('enforces read-only, ask, and fully-allowed file write modes', async () => {
    const call = { id: 'write', function: { name: 'write_file', arguments: '{"path":"notes/result.md","content":"hello"}' } };
    const workspace = { writeFile: vi.fn(async () => {}) };
    const readOnly = createClientTools(workspace, { fileAccessMode: 'read-only' });
    expect(readOnly.definitions.map((item) => item.function.name)).not.toContain('write_file');
    expect(JSON.parse(await readOnly.execute(call))).toMatchObject({ written: false, reason: '当前对话为只读模式' });

    const confirm = vi.fn(async () => false);
    const ask = createClientTools(workspace, { fileAccessMode: 'ask', confirm });
    expect(JSON.parse(await ask.execute(call))).toMatchObject({ written: false, reason: '用户拒绝写入' });
    expect(confirm).toHaveBeenCalledOnce();

    const allowConfirm = vi.fn();
    const allow = createClientTools(workspace, { fileAccessMode: 'allow', confirm: allowConfirm });
    expect(JSON.parse(await allow.execute(call))).toMatchObject({ written: true, chars: 5 });
    expect(allowConfirm).not.toHaveBeenCalled();
    expect(workspace.writeFile).toHaveBeenCalledWith('notes/result.md', 'hello');
  });

  it('returns every matching @ candidate unless a limit is explicitly requested', () => {
    const nodes = Array.from({ length: 18 }, (_, index) => ({ id: `node:${index}`, number: `${index + 1}`, title: `共同关键词 ${index}`, importance: 0 }));
    const model = { nodes, nodeById: new Map(nodes.map((node) => [node.id, node])) };
    const files = Array.from({ length: 4 }, (_, index) => ({ name: `共同关键词-${index}.pdf`, path: `uploads/${index}.pdf` }));
    expect(searchMentionCandidates(model, files, '共同关键词')).toHaveLength(22);
    expect(searchMentionCandidates(model, files, '', 5)).toHaveLength(5);
  });

  it('routes graph references to the graph when the details reader is closed', () => {
    const node = { id: 'lem:appell' };
    const ctx = {
      graph: { getZoomScale: vi.fn(() => 1.25), focusNode: vi.fn() },
      modals: { openFromNode: vi.fn() },
      openDetails: vi.fn(),
    };
    expect(navigateGraphReference(ctx, node, { id: 'eq:appell' })).toBe('graph');
    expect(ctx.graph.focusNode).toHaveBeenCalledWith('lem:appell', 1.25);
    expect(ctx.modals.openFromNode).toHaveBeenCalledWith(node, { scrollLabel: 'eq:appell' });
    expect(ctx.openDetails).not.toHaveBeenCalled();
  });

  it('routes graph references to the exact details page when the reader is open', () => {
    const node = { id: 'lem:appell' };
    const ctx = {
      _reader: { el: { isConnected: true } },
      graph: { focusNode: vi.fn() },
      modals: { openFromNode: vi.fn() },
      openDetails: vi.fn(),
    };
    expect(navigateGraphReference(ctx, node, { id: 'eq:appell' })).toBe('details');
    expect(ctx.openDetails).toHaveBeenCalledWith('lem:appell', { labelId: 'eq:appell' });
    expect(ctx.graph.focusNode).not.toHaveBeenCalled();
    expect(ctx.modals.openFromNode).not.toHaveBeenCalled();
  });

  it('parses SSE events split across network chunks', () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"choices":[{"del')).toEqual([]);
    expect(decoder.push('ta":{"content":"hi"}}]}\n\n')).toEqual(['{"choices":[{"delta":{"content":"hi"}}]}']);
    expect(decoder.push('data: [DONE]', true)).toEqual(['[DONE]']);
  });

  it('continues beyond eight tool rounds until the model returns a final answer', async () => {
    const encoder = new TextEncoder();
    const streamResponse = (delta) => {
      const payload = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
      let sent = false;
      return {
        ok: true,
        body: { getReader: () => ({
          read: async () => sent
            ? { done: true, value: undefined }
            : (sent = true, { done: false, value: encoder.encode(payload) }),
        }) },
      };
    };
    let request = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      request += 1;
      if (request <= 9) return streamResponse({
        tool_calls: [{
          index: 0,
          id: `call-${request}`,
          function: { name: 'web_search', arguments: `{"query":"query ${request}"}` },
        }],
      });
      return streamResponse({ content: '任务已完成。' });
    }));
    const tools = {
      definitions: [],
      beginBatch: vi.fn(),
      execute: vi.fn(async () => JSON.stringify({ results: [] })),
    };
    const output = await runAgentTurn({
      config: { baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'test-key' },
      history: [],
      userText: '继续研究直到完成',
      tools,
    });
    expect(output).toBe('任务已完成。');
    expect(tools.execute).toHaveBeenCalledTimes(9);
    expect(fetch).toHaveBeenCalledTimes(10);
  });

  it('removes only web_search after no_new_results while keeping precise tools available', async () => {
    const encoder = new TextEncoder();
    const responseFor = (delta) => {
      const payload = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
      let sent = false;
      return { ok: true, body: { getReader: () => ({ read: async () => sent
        ? { done: true }
        : (sent = true, { done: false, value: encoder.encode(payload) }) }) } };
    };
    const requestTools = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      requestTools.push(JSON.parse(options.body).tools.map((tool) => tool.function.name));
      return requestTools.length === 1
        ? responseFor({ tool_calls: [{ index: 0, id: 'search-1', function: { name: 'web_search', arguments: '{"query":"same"}' } }] })
        : responseFor({ content: '基于已有来源作答。' });
    }));
    const tools = {
      definitions: ['web_search', 'open_url', 'resolve_doi'].map((name) => ({ type: 'function', function: { name } })),
      beginBatch: vi.fn(),
      execute: vi.fn(async () => JSON.stringify({ no_new_results: true, results: [] })),
    };
    await runAgentTurn({
      config: { baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'test-key' },
      history: [], userText: '研究问题', tools,
    });
    expect(requestTools).toEqual([
      ['web_search', 'open_url', 'resolve_doi'],
      ['open_url', 'resolve_doi'],
    ]);
  });

  it('normalizes safe workspace paths', () => {
    expect(normalizeWorkspacePath('uploads\\paper.pdf')).toBe('uploads/paper.pdf');
    expect(normalizeWorkspacePath('/notes/summary.md')).toBe('notes/summary.md');
  });

  it('rejects paths that escape the workspace', () => {
    expect(() => normalizeWorkspacePath('../secret.txt')).toThrow('无效的工作区路径');
    expect(() => normalizeWorkspacePath('')).toThrow('无效的工作区路径');
  });

  it('keeps text and tool calls in chronological order', () => {
    const message = { role: 'assistant', content: '', blocks: [] };
    appendReasoningBlock(message, '需要先找到来源。');
    appendTextBlock(message, '先搜索一下。');
    upsertToolBlock(message, { id: 'call-1', name: 'web_search', args: { query: 'UCP' } }, 'running');
    upsertToolBlock(message, { id: 'call-1', name: 'web_search', result: { results: [] } }, 'done');
    appendTextBlock(message, '这是搜索后的结论。');
    expect(messageBlocks(message).map((block) => block.type)).toEqual(['reasoning', 'text', 'tool', 'text']);
    expect(message.blocks[2].status).toBe('done');
  });

  it('renders reasoning and tools in their original timeline order', () => {
    const activity = [
      { type: 'reasoning', content: '先判断问题' },
      { type: 'tool', name: 'web_search', key: 'search-1' },
      { type: 'reasoning', content: '根据搜索结果继续判断' },
      { type: 'tool', name: 'read_file', key: 'file-1' },
      { type: 'tool', name: 'web_search', key: 'search-2' },
    ];
    expect(activityTimelineEntries(activity).map(({ block }) => block.type === 'reasoning' ? 'reasoning' : block.name)).toEqual([
      'reasoning', 'web_search', 'reasoning', 'read_file', 'web_search',
    ]);
  });

  it('keeps the process group open until body text follows the completed tools', () => {
    const queued = [{ type: 'reasoning' }, { type: 'tool', status: 'done' }, { type: 'tool', status: 'queued' }];
    const completed = queued.map((block) => block.type === 'tool' ? { ...block, status: 'done' } : block);
    expect(isActivityGroupActive(queued, { messageActive: true, isTail: true })).toBe(true);
    expect(isActivityGroupActive(completed, { messageActive: true, isTail: true })).toBe(true);
    expect(isActivityGroupActive(completed, { messageActive: true, isTail: false })).toBe(false);
    expect(isActivityGroupActive(completed, { messageActive: false, isTail: true })).toBe(false);
  });

  it('keeps consecutive reasoning and tool batches in one process segment', () => {
    expect(shouldJoinActivityBlock({ type: 'tool', status: 'done' }, { type: 'reasoning' })).toBe(true);
    expect(shouldJoinActivityBlock({ type: 'reasoning' }, { type: 'tool', status: 'queued' })).toBe(true);
    expect(shouldJoinActivityBlock({ type: 'tool', status: 'done' }, { type: 'tool', status: 'queued' })).toBe(true);
    expect(shouldJoinActivityBlock(
      { type: 'tool', status: 'done', batch: 1 },
      { type: 'tool', status: 'queued', batch: 2 },
    )).toBe(true);
    expect(shouldJoinActivityBlock({ type: 'tool', status: 'done' }, { type: 'text' })).toBe(false);
  });

  it('replaces an edited user input and removes its old conversation branch', () => {
    const messages = [
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' },
      { role: 'user', content: '旧输入', createdAt: '2026-01-01' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '后续问题' },
    ];
    expect(replaceUserMessageBranch(messages, 2, '修改后的输入', '2026-07-14')).toEqual([
      messages[0], messages[1],
      { role: 'user', content: '修改后的输入', createdAt: '2026-01-01', editedAt: '2026-07-14' },
    ]);
  });

  it('converts an assistant answer into a titleless floating note', () => {
    expect(noteFromAssistantMessage(
      { role: 'assistant', content: '  **回答正文**\n\n更多内容  ' },
      { id: 'note-from-ai', now: '2026-07-15T12:00:00.000Z' },
    )).toEqual({
      id: 'note-from-ai', title: '', content: '**回答正文**\n\n更多内容', tagPointer: null,
      createdAt: '2026-07-15T12:00:00.000Z', updatedAt: '2026-07-15T12:00:00.000Z',
    });
    expect(noteFromAssistantMessage({ role: 'assistant', content: '   ' })).toBeNull();
  });

  it('copies complete debug data including reasoning and tool results', () => {
    const message = { role: 'assistant', content: '结论', blocks: [], sources: [{ citation: '[S1]', title: 'Source', url: 'https://example.com' }] };
    appendReasoningBlock(message, '检查资料');
    upsertToolBlock(message, { id: 'call-1', name: 'web_search', args: { query: 'test' }, result: { results: [{ citation: '[S1]' }] } }, 'done');
    appendTextBlock(message, '结论 [S1]');
    const debug = serializeMessageDebug(message, { index: 2 });
    expect(debug).toContain('## Block 1: reasoning');
    expect(debug).toContain('检查资料');
    expect(debug).toContain('name: web_search');
    expect(debug).toContain('"query": "test"');
    expect(debug).toContain('## Sources');
  });

  it('reads provider-exposed reasoning deltas', () => {
    expect(readReasoningDelta({ reasoning_content: '思考中' })).toBe('思考中');
    expect(readReasoningDelta({ thinking: 'checking' })).toBe('checking');
    expect(readReasoningDelta({ content: 'answer' })).toBe('');
  });

  it('protects model math from Markdown backslash escaping', () => {
    const source = String.raw`display:
\[
-\Delta u + V(x)u = 0 \quad \text{或} \quad -\Delta u = \lambda u
\]
inline \(u \in L^2(\mathbb R^n)\)

code: \`\\(not math\\)\`

\`\`\`tex
\\[not math either\\]
\`\`\``;
    const protectedMath = protectMarkdownMath(source);
    expect(protectedMath.expressions).toEqual([
      String.raw`\[
-\Delta u + V(x)u = 0 \quad \text{或} \quad -\Delta u = \lambda u
\]`,
      String.raw`\(u \in L^2(\mathbb R^n)\)`,
    ]);
    expect(protectedMath.markdown).toContain('AIPANELMATHTOKEN0ENDTOKEN');
    expect(protectedMath.markdown).toContain(String.raw`\`\\(not math\\)\``);
    expect(protectedMath.markdown).toContain(String.raw`\\[not math either\\]`);
  });

  it('removes Markdown quote markers from display math inside a blockquote', () => {
    const source = String.raw`> 结论如下：
> \[
> T^2 c_0 c_1 > \frac{1}{16}
> \]
> 因此成立。`;
    const protectedMath = protectMarkdownMath(source);
    expect(protectedMath.expressions).toEqual([String.raw`\[
T^2 c_0 c_1 > \frac{1}{16}
\]`]);
    expect(protectedMath.markdown).toContain('> AIPANELMATHTOKEN0ENDTOKEN');
    expect(stripBlockquoteMathMarkers('x\n> y', '> x', 2)).toBe('x\ny');
  });

  it('repairs CommonMark strong emphasis blocked by CJK punctuation', () => {
    expect(normalizeCjkStrong('方程**唯一延拓性（UCP）**的主要学者'))
      .toBe('方程<strong>唯一延拓性（UCP）</strong>的主要学者');
    expect(normalizeCjkStrong('这是**正常加粗**内容')).toBe('这是**正常加粗**内容');
    expect(normalizeCjkStrong('`方程**唯一延拓性（UCP）**的`'))
      .toBe('`方程**唯一延拓性（UCP）**的`');
    expect(normalizeCjkStrong('```md\n方程**唯一延拓性（UCP）**的\n```'))
      .toBe('```md\n方程**唯一延拓性（UCP）**的\n```');
  });

  it('formats AI graph references with the graph display label', () => {
    const theorem = { node: { typeLabel: 'Theorem', number: '1', title: 'Sharp one-sided uniqueness' }, label: { id: 'thm:conditional', kind: 'theorem', number: '1' } };
    const equation = { node: { typeLabel: 'Theorem', number: '1' }, label: { id: 'eq:threshold', kind: 'equation', number: '4' } };
    expect(formatGraphReferenceDisplay(theorem, 'thm:conditional')).toBe('Theorem 1');
    expect(formatGraphReferenceDisplay(equation, 'eq:threshold')).toBe('(4)');
  });

  it('classifies transient stream failures for recovery', () => {
    expect(isRetryableStreamError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableStreamError(new Error('模型请求失败（503）：upstream unavailable'))).toBe(true);
    expect(isRetryableStreamError(new Error('模型请求失败（400）：bad request'))).toBe(false);
    expect(isRetryableStreamError(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });

  it('assigns stable citation markers to web search results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('wikipedia.org')) {
        const query = new URL(url).searchParams.get('srsearch');
        return { ok: true, json: async () => ({ query: { search: [{ title: query, snippet: 'A mathematical property.' }] } }) };
      }
      return { ok: true, json: async () => ({ message: { items: [] } }) };
    }));
    const tools = createClientTools({});
    const first = JSON.parse(await tools.execute({ id: '1', function: { name: 'web_search', arguments: '{"query":"UCP"}' } }));
    const second = JSON.parse(await tools.execute({ id: '2', function: { name: 'web_search', arguments: '{"query":"Carleman"}' } }));
    expect(first.results[0].citation).toBe('[S1]');
    expect(second.results[0].citation).toBe('[S2]');
  });

  it('does not impose a per-turn web search call limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('wikipedia.org')) {
        const query = new URL(url).searchParams.get('srsearch');
        return { ok: true, json: async () => ({ query: { search: [{ title: `Result ${query}`, snippet: 'Excerpt' }] } }) };
      }
      return { ok: true, json: async () => ({ message: { items: [] } }) };
    }));
    const tools = createClientTools({});
    const results = [];
    for (let index = 1; index <= 4; index += 1) {
      results.push(JSON.parse(await tools.execute({
        id: String(index),
        function: { name: 'web_search', arguments: `{"query":"query ${index}"}` },
      })));
    }
    expect(results.every((result) => !result.skipped && result.results.length > 0)).toBe(true);
    expect(results[3].results[0].citation).toBe('[S4]');
  });

  it('normalizes DOI URLs and tracking variants to one global source', () => {
    expect(extractDoi('https://doi.org/10.1090/CAMS/50?utm_source=test')).toBe('10.1090/cams/50');
    expect(canonicalSourceKey({ url: 'https://DOI.org/10.1090/CAMS/50/' })).toBe('doi:10.1090/cams/50');
    expect(canonicalSourceKey({ url: 'http://example.com/paper/?utm_source=x&b=2&a=1#section' }))
      .toBe('url:example.com/paper?a=1&b=2');
  });

  it('returns no_new_results after two highly overlapping searches and stops searching', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('wikipedia.org')) return { ok: true, json: async () => ({ query: { search: [] } }) };
      return { ok: true, json: async () => ({ message: { items: [{
        DOI: '10.1090/cams/50', title: ['Same paper'], URL: 'https://doi.org/10.1090/cams/50',
      }] } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const tools = createClientTools({}, {
      initialSources: [{ citation: '[S7]', title: 'Same paper', url: 'https://doi.org/10.1090/CAMS/50/' }],
    });
    const call = (id) => tools.execute({ id, function: { name: 'web_search', arguments: `{"query":"variant ${id}"}` } });
    const first = JSON.parse(await call('1'));
    const second = JSON.parse(await call('2'));
    const third = JSON.parse(await call('3'));
    expect(first.results).toEqual([]);
    expect(first.reused_sources[0].citation).toBe('[S7]');
    expect(second).toMatchObject({ status: 'no_new_results', no_new_results: true });
    expect(third).toMatchObject({ status: 'no_new_results', no_new_results: true, results: [] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('reads an explicit webpage through the reader endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => 'Title: Example Paper\n\nMarkdown Content:\nAuthor: Ada Example',
    }));
    const tools = createClientTools({});
    const result = JSON.parse(await tools.execute({
      id: 'open-1', function: { name: 'open_url', arguments: '{"url":"https://example.com/paper"}' },
    }));
    expect(result).toMatchObject({ title: 'Example Paper', citation: '[S1]', truncated: false });
    expect(fetch).toHaveBeenCalledWith('https://r.jina.ai/https://example.com/paper', expect.any(Object));
  });

  it('resolves exact DOI metadata including full authors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: {
        DOI: '10.1090/cams/50', title: ['A paper'], author: [{ given: 'Ada', family: 'Example', ORCID: 'https://orcid.org/0000' }],
        published: { 'date-parts': [[2024, 5, 2]] }, 'container-title': ['Communications'], publisher: 'AMS', type: 'journal-article',
      } }),
    }));
    const tools = createClientTools({});
    const result = JSON.parse(await tools.execute({
      id: 'doi-1', function: { name: 'resolve_doi', arguments: '{"doi":"https://doi.org/10.1090/CAMS/50"}' },
    }));
    expect(result).toMatchObject({ doi: '10.1090/cams/50', citation: '[S1]', authors: [{ name: 'Ada Example' }] });
  });

  it('treats a missing DOI as a recoverable lookup result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const tools = createClientTools({});
    const result = JSON.parse(await tools.execute({
      id: 'doi-missing', function: { name: 'resolve_doi', arguments: '{"doi":"10.1007/s00222-008-0120-9"}' },
    }));
    expect(result).toMatchObject({ status: 'not_found', doi: '10.1007/s00222-008-0120-9', results: [] });
    expect(result.message).toContain('不要重复解析');
  });

  it('instructs the model never to invent DOI values', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('绝对不要根据标题、作者或记忆猜测 DOI');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('DOI 未找到时不要重复解析');
  });

  it('keeps uploaded-file citations separate from graph references', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('project.paper-graph.json 和图谱节点不能代替该文件');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('绝对不要输出文件源码中的 \\ref{...}');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('《文件名》p. 页码');
  });

  it('uses Crossref as a scholarly fallback for web search', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('crossref.org')) return {
        ok: true,
        json: async () => ({ message: { items: [{
          DOI: '10.2307/1971205',
          title: ['Unique Continuation and Absence of Positive Eigenvalues'],
          URL: 'https://doi.org/10.2307/1971205',
          author: [{ given: 'David', family: 'Jerison' }],
          published: { 'date-parts': [[1985]] },
        }] } }),
      };
      return { ok: true, json: async () => ({ query: { search: [] } }) };
    }));
    const tools = createClientTools({});
    const result = JSON.parse(await tools.execute({ id: '1', function: { name: 'web_search', arguments: '{"query":"Schrodinger unique continuation"}' } }));
    expect(result.results[0]).toMatchObject({ provider: 'Crossref', citation: '[S1]' });
  });

  it('only follows streaming output inside the bottom threshold', () => {
    expect(isScrollNearBottom({ scrollHeight: 1000, scrollTop: 770, clientHeight: 200 })).toBe(true);
    expect(isScrollNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 })).toBe(false);
  });
});
