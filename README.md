# 本地 JSON Patch 文档修订与原子回滚服务

这是一个只包含后端 API 与 CLI 的本地 JSON 文档版本服务，使用 TypeScript、Node.js 和 Node.js 内置的 SQLite（`node:sqlite`）实现。数据默认保存在项目内的 `data/json-patch.sqlite`，不需要 Docker、WSL、外部在线 API 或付费服务。

## 功能

- 保存命名 JSON 文档及不可变历史版本。
- 按顺序执行 JSON Patch 六种操作：`add`、`remove`、`replace`、`move`、`copy`、`test`。
- 正确处理 RFC 6901 JSON Pointer：`~0` 表示 `~`，`~1` 表示 `/`。
- 区分对象属性、数组下标、`null` 值和缺失路径。
- 数组插入使用 `splice` 移动后续元素；`/0`、`/length` 范围和 `-` 按规则校验。
- `move`/`copy` 读取必须存在的路径；`copy` 为深复制，后续修改不影响来源。
- 每组补丁先在完整深副本上试算；任一操作失败则整组拒绝，不修改正式数据。
- 提交必须携带 `expectedBaseVersion`；基础版本变化时返回 `409 VERSION_CONFLICT`。
- 失败尝试写入 `failed_attempts` 表，包含失败操作序号、路径和原因，但不增加成功版本号。
- 服务重启后可以读取旧版本、最新版本和成功修订记录。

## 不支持的范围

- 不实现文本差异算法，只处理结构化 JSON 值。
- 不提供浏览器页面、鉴权、多人实时编辑或 WebSocket。
- 不执行用户脚本、模板表达式或任意代码。
- 当前没有逻辑删除文档的接口；SQLite 外键级联已为后续删除能力做好准备。
- 仅监听 `127.0.0.1`，定位为本机后端服务。

## 环境要求

- Windows 本地 PowerShell。
- Node.js 22.5+（当前使用 Node.js 25 测试通过）。`node:sqlite` 在较新 Node 中仍可能输出实验性 API 提示，但功能可用。

## 安装、构建与测试

```powershell
npm install
npm run build
npm test
```

启动 HTTP 服务：

```powershell
npm start
```

默认端口为 `0`，操作系统会自动选择空闲端口，启动日志会输出实际地址。指定端口：

```powershell
$env:PORT="3000"; npm start
```

指定数据库文件：

```powershell
$env:JSON_PATCH_DB="$PWD\\data\\custom.sqlite"; npm start
```

运行端到端演示：

```powershell
npm run demo
```

演示会重新创建 `data/demo.sqlite`，展示数组插入、斜杠属性、移动、深复制、条件测试，并在最后让补丁失败后重查完整回滚结果。

## HTTP API

请求和响应均为 JSON，最大请求体 8 MiB。

### 创建文档

`POST /documents`

```json
{ "name": "demo", "content": { "items": [] } }
```

初始成功版本号为 `0`。文档名为 1 到 128 个中文、字母、数字、`_`、`.` 或 `-`。

### 获取最新文档

`GET /documents/demo`

### 获取指定版本

`GET /documents/demo/versions/0`

### 预览补丁

`POST /documents/demo/preview`

```json
{
  "expectedBaseVersion": 0,
  "patch": [
    { "op": "add", "path": "/items/-", "value": { "id": "new" } },
    { "op": "test", path": "/items/0/id", "value": "old" }
  ]
}
```

预览只返回试算结果，不写入版本。

### 原子提交补丁

`POST /documents/demo/commit`

请求体与预览相同。服务先在事务外完整验证和试算，再在 SQLite 事务内重新检查当前版本，然后同时写入新版本内容和修订记录。如果基础版本已变化，返回：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "预期基础版本 0，当前版本已是 1",
    "currentVersion": 1,
    "expectedBaseVersion": 0
  }
}
```

### 修订记录

`GET /documents/demo/revisions`

只记录成功提交，版本 `0` 是创建时的基线内容，不在修订表中。

### 导出文档

```http
GET /documents/demo/export
GET /documents/demo/export?version=0
```

## 错误响应

补丁失败使用 HTTP `422`，例如：

```json
{
  "error": {
    "code": "TEST_FAILED",
    "message": "test 操作的期望值与当前值不一致",
    "operationIndex": 2,
    "path": "/checks/enabled"
  }
}
```

`operationIndex` 从 0 开始，与请求补丁数组中的序号一致。常见错误码包括：

- `INVALID_OPERATION`：操作结构或字段错误。
- `INVALID_POINTER`：JSON Pointer 语法非法。
- `POINTER_NOT_FOUND`：路径不存在；`null` 不算缺失。
- `TYPE_MISMATCH`：把非容器值当作对象或数组遍历。
- `INVALID_ARRAY_INDEX`：数组下标非法或越界。
- `TEST_FAILED`：条件测试不相等。
- `INVALID_MOVE`：把路径移动到自身或后代路径。
- `VERSION_CONFLICT`：乐观锁基础版本不匹配。

## CLI

CLI 直接访问 SQLite 文件，适合脚本和离线使用：

```powershell
npm run cli -- serve --port 3000
npm run cli -- create --name demo --json '{"items":[]}'
npm run cli -- get --name demo
npm run cli -- version --name demo --version 0
npm run cli -- preview --name demo --input patch.json
npm run cli -- commit --name demo --input patch.json
npm run cli -- history --name demo
npm run cli -- export --name demo --version 1
```

`patch.json` 示例：

```json
{
  "expectedBaseVersion": 0,
  "patch": [{ "op": "add", "path": "/items/-", "value": { "id": "new" } }]
}
```

## 数据结构

- `documents`：文档名、当前版本、更新时间。
- `versions`：每个成功版本的完整 JSON 快照。
- `revisions`：成功补丁、基础版本、结果版本和成功结果。
- `failed_attempts`：失败补丁、错误码、错误消息、失败序号和路径。

采用完整版本快照而不是补丁回放，因此旧版本读取简单可靠，也便于导出和审计。
