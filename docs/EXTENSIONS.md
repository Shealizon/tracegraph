# Paper Graph Skills 与工具扩展

## 权限与生命周期

- 只有 `admin` 角色可以通过管理员面板或 `/api/admin/extensions/import` 导入扩展。
- 所有已登录用户可以读取扩展目录，并在 AI 会话中使用状态为“可用”的工具。
- 每个包含 Python 工具的扩展都有独立 `.venv`。导入时服务器自动创建环境、安装 manifest 中的依赖并编译检查入口。
- 工具只看到当前对话工作区的临时快照。生成文件必须放入协议提供的 `context.output`，随后由服务器写回该用户的加密工作区。
- 内置扩展随服务器首次启动自动安装；同一 ID 出现更高版本时自动更新。
- `requiredEnv` 可由管理员在扩展卡片中配置。密钥使用服务器会话密钥进行 AES-256-GCM 加密，
  API 只返回“已配置/未配置”状态，绝不返回原值；操作系统环境变量优先级高于面板配置。

生产镜像必须提供 Python 3.9+、`pip` 和 `venv`。可用 `PAPER_GRAPH_PYTHON` 指定解释器；
系统存在多个 Python 时会跳过不满足版本要求的旧解释器。单个内置扩展安装失败不会阻止主服务启动，
失败原因会记录到服务日志和扩展目录的 `failures` 字段。

## 导入包格式

导入文件是 UTF-8 JSON：

```json
{
  "format": "paper-graph-extension@1",
  "manifest": {
    "id": "example-tools",
    "name": "Example Tools",
    "version": "1.0.0",
    "description": "Example extension",
    "dependencies": {
      "python": ["requests>=2.32,<3"]
    },
    "requiredEnv": ["EXAMPLE_TOKEN"],
    "skills": [
      {
        "id": "example-reader",
        "name": "Example Reader",
        "description": "Read example files",
        "file": "skills/example.md"
      }
    ],
    "tools": [
      {
        "name": "example_read",
        "action": "read",
        "description": "Read an example file",
        "inputSchema": {
          "type": "object",
          "properties": {
            "file": { "type": "string" }
          },
          "required": ["file"],
          "additionalProperties": false
        },
        "entry": "tools/example.py",
        "readOnly": true,
        "timeoutMs": 180000
      }
    ]
  },
  "files": [
    {
      "path": "skills/example.md",
      "encoding": "utf8",
      "data": "# Example Reader\n..."
    },
    {
      "path": "tools/example.py",
      "encoding": "utf8",
      "data": "import json, sys\n..."
    }
  ]
}
```

约束：

- ID 使用小写字母、数字和连字符；工具名使用函数标识符。
- Python 依赖只接受包名和版本约束，不接受 URL、文件路径、额外 pip 参数或 shell 命令。
- 包最多 120 个文件，解码后最多 12 MB。
- 工具入口当前只支持 Python `.py`。
- 纯读取工具应声明 `"readOnly": true`。未声明时按“可能写入”处理，并受当前对话的文件写入权限控制。
- `requiredEnv` 只声明变量名，不把密钥写进扩展包。缺少变量时工具对用户显示为不可用。

## Python 工具协议

工具从 stdin 读取一个 JSON 对象：

```json
{
  "protocol": "paper-graph-extension@1",
  "tool": "example_read",
  "action": "read",
  "args": { "file": "uploads/example.pdf" },
  "context": {
    "workspace": "/temporary/workspace",
    "output": "/temporary/output",
    "projectId": "project-id",
    "workspaceScope": "project--conversation"
  }
}
```

同样的信息也通过环境变量提供：

- `PAPER_GRAPH_WORKSPACE`
- `PAPER_GRAPH_OUTPUT`
- `PAPER_GRAPH_EXTENSION_DATA`
- `PAPER_GRAPH_TOOL`
- `PAPER_GRAPH_TOOL_ACTION`

stdout 最后一行必须是 JSON 对象。生成文件用 `artifacts` 声明：

```json
{
  "ok": true,
  "summary": "created",
  "artifacts": [
    {
      "path": "result.pdf",
      "workspacePath": "generated/result.pdf",
      "name": "result.pdf",
      "type": "application/pdf"
    }
  ]
}
```

`path` 相对于临时输出目录，`workspacePath` 是写回用户工作区的相对路径。单个产物最大 20 MB。

## 打包与导入

扩展源码目录使用与 `extensions/builtin/pdf-workbench/` 相同的结构：

```text
my-extension/
├── manifest.json
├── skills/
└── tools/
```

生成管理员可导入的 JSON：

```bash
npm run pack:extension -- ./my-extension ./my-extension.extension.json
```

管理员打开“管理员面板 → Skills 与工具 → 导入扩展包”，选择生成的 JSON。依赖安装完成后，工具会自动加入用户后续 AI 请求。

## 内置扩展

- `pdf-workbench`：文字提取、页码检索、转图、创建、合并、抽页、旋转、拆分、删页、插页、图片叠加和水印。
- `paddle-ocr`：扫描 PDF/图片 OCR；需要服务器配置 `PADDLEOCR_TOKEN`。
