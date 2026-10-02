# JSON Patch 文档修订与原子回滚服务

本地运行的 JSON 文档版本化服务：保存命名文档的不可变版本，接收一组 [RFC 6902 JSON Patch](https://datatracker.ietf.org/doc/html/rfc6902) 操作，支持**预览**与**原子提交**。仅提供 HTTP API 与命令行（CLI），无前端、无外部依赖服务。

- 语言/运行时：TypeScript + Node.js（需 Node.js ≥ 22，开发验证版本 v25.5.0）
- 数据库：内置 `node:sqlite`（SQLite，WAL 模式），无需安装任何数据库或编译原生模块
- 平台：Windows 本地直接运行，不依赖 Docker / WSL / 付费服务 / 在线 API

## 支持的规范语义

### JSON Pointer（RFC 6901）

- 空指针 `""` 指向整个根文档，可以是对象、数组、字符串、数字、布尔或 `null`。
- 路径以 `/` 分段；`~0` 表示字面量 `~`，`~1` 表示字面量 `/`（如属性 `a/b` 写作 `/a~1b`）。
- 其它 `~x` 形式为非法转义；非空指针必须以 `/` 开头。
- 数组索引必须是十进制整数、无前导零（`0` 除外）；对象属性名与数组索引严格区分，`"/arr/length"` 之类不会被当作属性访问。
- 数组末尾标记 `-` 仅在 `add` 时表示在尾部追加。

### JSON Patch（RFC 6902）六种操作

| 操作 | 语义 |
| --- | --- |
| `add` | 对象新增/覆盖属性；数组在索引处插入（后续元素后移），索引等于长度或使用 `-` 时追加；根路径整体替换文档 |
| `remove` | 删除对象属性或数组元素（后续元素前移）；目标必须存在；不允许移除根 |
| `replace` | 语义等同“同路径 remove 后 add”，但要求目标**必须已存在**；根路径可整体替换 |
| `move` | 语义等同“从 `from` remove 后 add 到 `path`”，深层移动；**禁止移动到自身后代路径** |
| `copy` | 从 `from` 深复制后 add 到 `path`；副本与来源完全独立，后续修改互不影响 |
| `test` | 比较路径当前值与 `value` 是否深度相等；`null` 与“属性缺失”是两种不同情况，缺失路径的 `test` 一律失败 |

其它要点：

- 操作按顺序执行，每一步都基于上一步的结果；数组在 `move`/`remove` 后立即重排索引。
- **原子性**：整组补丁先在内存中的深拷贝上执行，任何一步失败（`test` 不通过、路径不存在、索引越界、非法 `move`、形状非法等）都拒绝整组补丁，原始输入与已提交版本不受任何影响。
- 错误响应包含出错操作的**序号（从 0 开始）**、`path`、`from` 与中文原因及错误码。

### 版本与并发（乐观并发控制）

- 提交必须携带 `base_version`；只有当它等于当前最新成功版本时才提交，新版本号为 `base_version + 1`，写入在 SQLite 事务（`BEGIN IMMEDIATE`）中完成。
- 基础版本已变化时返回 `409 VERSION_CONFLICT`，不会覆盖别人的新版本。
- 预览（preview）只计算结果，不写入任何正式版本。
- 失败的提交尝试可记录在修订记录中（`success=0`，无成功版本号），**不会增加成功版本号**，也不会改动最新内容。

## 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `INVALID_JSON` / `VALIDATION_ERROR` | 请求体不是合法 JSON / 参数校验失败 |
| 404 | `NOT_FOUND` | 文档或版本不存在、路由不存在 |
| 409 | `DOC_EXISTS` / `VERSION_CONFLICT` | 文档名重复 / 基础版本过期冲突 |
| 422 | `POINTER_INVALID` | 非法 JSON Pointer（格式、转义） |
| 422 | `POINTER_NOT_FOUND` / `POINTER_PARENT_NOT_FOUND` | 路径或父级不存在（`remove`/`replace`/`test`/`from` 等） |
| 422 | `BAD_ARRAY_INDEX` / `INDEX_OUT_OF_BOUNDS` | 数组索引非法或越界 |
| 422 | `TEST_FAILED` | test 断言失败，或 test 路径缺失 |
| 422 | `MOVE_INTO_DESCENDANT` | move 目标位于来源的后代路径 |
| 422 | `OP_NOT_SUPPORTED` | op 不是六种支持的操作 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

错误体示例：

```json
{
  "error": {
    "code": "TEST_FAILED",
    "message": "test 失败：当前值 1 不等于预期 2",
    "op_index": 1,
    "path": "/x"
  }
}
```

## HTTP API

服务监听 `127.0.0.1`。不设置 `PORT` 时**自动选择一个空闲端口**并打印到控制台。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/documents` | 创建文档：`{"name":"demo","content":{...}}`（content 可任意 JSON 值） |
| `GET` | `/documents/{name或id}` | 获取文档最新版本与内容 |
| `GET` | `/documents/{key}/versions/{n}` | 获取指定成功版本（含补丁与内容） |
| `GET` | `/documents/{key}/revisions` | 修订记录（含成功版本与失败尝试） |
| `POST` | `/documents/{key}/preview` | 预览：`{"base_version":1,"patch":[...]}`，不写入 |
| `POST` | `/documents/{key}/commits` | 原子提交：`{"base_version":1,"patch":[...]}` |
| `GET` | `/documents/{key}/export?version=n` | 导出指定版本（省略 version 导出最新） |

## CLI

CLI 直接读写本地 SQLite 文件，无需先启动服务。

```
npm run cli -- create <名称> <初始JSON | --file 文件>
npm run cli -- get <名称|ID>
npm run cli -- version <名称|ID> <版本号>
npm run cli -- revisions <名称|ID>
npm run cli -- preview <名称|ID> --base <版本号> <补丁JSON数组 | --file 文件>
npm run cli -- commit  <名称|ID> --base <版本号> <补丁JSON数组 | --file 文件>
npm run cli -- export  <名称|ID> [--version <版本号>]
```

通用选项：`--data-dir <目录>`（默认 `./data`，也可用环境变量 `JSONPATCH_DATA_DIR`）、`--file <路径>`。

## 运行命令

```powershell
# 1. 安装依赖
npm install

# 2. 构建（TypeScript -> dist/）
npm run build

# 3. 启动 HTTP 服务（自动选择空闲端口；数据在项目内 ./data）
npm start
# 或指定端口 / 数据目录
$env:PORT="8080"; $env:JSONPATCH_DATA_DIR="E:\GSB\0223\A\data"; npm start

# 4. 运行自动化测试（引擎 + 存储 + HTTP API，共 22 个用例）
npm test

# 5. 运行内置演示（数组插入、带斜杠属性、move、copy、条件 test、失败回滚、版本冲突）
npm run demo
```

### curl 快速示例（PowerShell）

```powershell
Invoke-RestMethod http://127.0.0.1:<端口>/documents -Method Post `
  -ContentType 'application/json' `
  -Body '{"name":"demo","content":{"tags":["x","y"],"meta":{"a/b":"v"}}}'
```

## 测试覆盖范围

- 六种操作的固定预期 JSON 核对（含根文档整体替换）
- `~0` / `~1` 转义、对象属性与数组索引不混淆、前导零与非数字索引
- 数组边界：头部插入后移、尾部追加、`-` 追加、越界拒绝
- `null` 与缺失属性的区别、根文档为 `null`
- `copy` 深复制独立性、`move` 重排与“移入后代”拒绝
- 顺序语义、失败整组回滚、输入对象不被中间操作修改
- 乐观版本冲突、失败尝试不升版本、失败后重新查询内容不变
- 关闭并重新打开数据库（模拟服务重启）后读取旧版本与最新版本

## 限制与合理假设

- 只处理 JSON 数据；不做文本 diff、不支持多人实时编辑、不执行任意脚本。
- 补丁与请求体大小上限 8MB；不实现 RFC 6902 之外的操作。
- 单机单 SQLite 文件，无鉴权（本地 127.0.0.1 服务）；并发安全依赖 SQLite 事务 + 乐观版本号。
- 版本号只统计成功提交，从 1 开始连续递增；失败尝试仅在修订记录中以 `success=0` 留存。
- 不自动清理历史版本；删除数据库文件即清空全部数据。
- `node:sqlite` 在当前 Node 中带实验性警告，不影响功能；后续 Node 版本 API 若变化需小幅适配。
