# MCP+RAG 服务启动指南

## 概述

本项目使用 **MCP (Model Context Protocol) + RAG (Retrieval-Augmented Generation)** 架构来实现临床指南查询功能。

**三层架构**：
```
前端 (React/Vite) → MCP Bridge (8787) → LightRAG Service (9621)
```

## 必须运行的 3 个服务

每次启动项目时，**必须按顺序启动以下 3 个服务**，否则 MCP 功能将不可用：

### 1. 前端开发服务器 (Vite)
**端口**：3003
**功能**：React 应用界面 + API 代理

**启动命令**：
```bash
cd <PROJECT_PATH>
npm run dev
```

**启动日志应显示**：
```
VITE v5.4.21  ready in XXX ms
➜  Local:   http://localhost:3003/
```

**检查方法**：浏览器访问 http://localhost:3003

---

### 2. MCP HTTP Bridge
**端口**：8787
**功能**：将前端请求转换为 MCP 协议调用，连接 LightRAG 服务

**启动命令**：
```bash
cd <PROJECT_PATH>
python mcp_http_bridge.py
```

**启动日志应显示**：
```
============================================================
启动 MCP HTTP Bridge Server
端口: 8787
============================================================
INFO:     Uvicorn running on http://0.0.0.0:8787
```

**检查方法**：
```bash
curl http://localhost:8787
```

---

### 3. LightRAG Service (临床指南检索后端)
**端口**：9621
**功能**：基于知识图谱的临床指南检索服务

**启动命令**：
```bash
cd <PROJECT_PATH>
python start_lightrag_custom.py
```

**启动日志应显示**：
```
INFO: Loaded graph from ... with 2246 nodes, 2235 edges
INFO:     Uvicorn running on http://127.0.0.1:9621
```

**检查方法**：
```bash
curl http://localhost:9621/health
```

---

## 快速启动脚本

**方式一：手动启动（推荐用于调试）**

打开 3 个终端窗口，分别运行：

**终端 1 - 前端**：
```bash
cd <PROJECT_PATH>
npm run dev
```

**终端 2 - MCP Bridge**：
```bash
cd <PROJECT_PATH>
python mcp_http_bridge.py
```

**终端 3 - LightRAG**：
```bash
cd <PROJECT_PATH>
python start_lightrag_custom.py
```

---

**方式二：后台启动（推荐用于开发）**

使用命令行工具启动所有服务在后台：

```bash
# 启动前端
start cmd /k "cd <PROJECT_PATH> && npm run dev"

# 启动 MCP Bridge
start cmd /k "cd <PROJECT_PATH> && python mcp_http_bridge.py"

# 启动 LightRAG
start cmd /k "cd <PROJECT_PATH> && python start_lightrag_custom.py"
```

---

## 服务健康检查

启动所有服务后，使用以下命令检查状态：

```bash
# Windows
netstat -ano | findstr "3003 8787 9621"

# 应该看到 3 个端口都在 LISTENING 状态
```

**预期输出**：
```
TCP    0.0.0.0:3003           0.0.0.0:0              LISTENING       <PID>
TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       <PID>
TCP    127.0.0.1:9621         0.0.0.0:0              LISTENING       <PID>
```

---

## 故障排查

### 问题 1：MCP 返回 0 条引用

**症状**：
```
📚 [模型名] MCP返回 0 条指南引用
⚠️ [模型名] MCP未返回任何指南引用！
```

**原因**：LightRAG 服务未运行

**解决方法**：
1. 检查 LightRAG 是否运行：`netstat -ano | findstr "9621"`
2. 如果没有运行，启动服务：
   ```bash
   cd clinical_rag_system
   python start_lightrag_custom.py
   ```

---

### 问题 2：ERROR: HTTP错误调用lightRAG

**症状**：
```
ERROR: HTTP错误调用lightRAG: [WinError 10061] 由于目标计算机积极拒绝，无法连接。
```

**原因**：LightRAG 服务未运行或端口冲突

**解决方法**：
1. 确认 LightRAG 服务正在运行
2. 检查端口 9621 是否被其他程序占用：
   ```bash
   netstat -ano | findstr "9621"
   ```
3. 如果被占用，终止占用进程或更改配置文件中的端口

---

### 问题 3：MCP Bridge 连接失败

**症状**：
```
GET http://localhost:8787/mcp/call net::ERR_CONNECTION_REFUSED
```

**原因**：MCP Bridge 未运行

**解决方法**：
```bash
cd clinical_rag_system
python mcp_http_bridge.py
```

---

### 问题 4：前端无法访问

**症状**：浏览器提示 "无法访问此网站"

**原因**：Vite 开发服务器未运行

**解决方法**：
```bash
cd <PROJECT_PATH>
npm run dev
```

---

## 完整的工作流程

1. **用户在前端输入病历** → 发送到 Vite 服务器 (3003)
2. **Vite 代理转发** → MCP Bridge (8787)
3. **MCP Bridge 处理** → 调用 LightRAG API (9621)
4. **LightRAG 检索** → 在知识图谱中搜索相关临床指南
5. **LightRAG 返回结果** → 包含引用的指南和文本片段
6. **MCP Bridge 格式化** → 转换为前端需要的格式
7. **前端显示** → 优化后的报告 + 指南引用

---

## API 端点

### 前端 API
- **URL**: http://localhost:3003
- **代理路径**:
  - `/api/apiplus/*` → <API_BASE_URL>
  - `/api/moonshot/*` → https://api.moonshot.cn
  - `/mcp/*` → http://localhost:8787

### MCP Bridge API
- **URL**: http://localhost:8787
- **端点**: `POST /mcp/call`
- **请求体**:
  ```json
  {
    "tool": "query_clinical_guidelines",
    "input": "查询内容..."
  }
  ```

### LightRAG API
- **URL**: http://localhost:9621
- **端点**:
  - `POST /api/v1/query` - 查询接口
  - `GET /health` - 健康检查

---

## 环境变量配置

确保 `.env.local` 文件包含所有必需的 API 密钥：

```bash
# APIPlus Configuration
VITE_API_URL_APIPLUS=/api/apiplus/v1/chat/completions
VITE_API_KEY_APIPLUS=<your-api-key>
VITE_API_KEY_APIPLUS_CLAUDE=<your-api-key>
VITE_API_KEY_APIPLUS_GEMINI=<your-api-key>

# Moonshot Configuration
VITE_API_URL_MOONSHOT=/api/moonshot/v1/chat/completions
VITE_API_KEY_MOONSHOT=<your-api-key>

# MCP Bridge Configuration
VITE_MCP_BRIDGE_URL=http://localhost:8787
```

---

## 重要提示

⚠️ **启动顺序很重要！**

建议按以下顺序启动：
1. LightRAG Service (9621) - 先启动，因为需要加载知识图谱
2. MCP Bridge (8787) - 依赖 LightRAG
3. Vite Frontend (3003) - 最后启动

⚠️ **不要关闭终端窗口！**

所有 3 个服务必须持续运行，关闭任何一个终端窗口都会导致对应服务停止。

⚠️ **数据文件位置**

LightRAG 知识图谱数据存储在：
```
clinical_rag_system/rag_storage/
├── graph_chunk_entity_relation.graphml  # 知识图谱
├── vdb_entities.json                     # 实体向量数据库
├── vdb_relationships.json                # 关系向量数据库
└── vdb_chunks.json                       # 文本块向量数据库
```

---

## 快速测试

启动所有服务后，运行以下测试确认 MCP+RAG 正常工作：

```bash
# 测试 MCP Bridge 连接
curl -X POST http://localhost:8787/mcp/call \
  -H "Content-Type: application/json" \
  -d '{"tool":"query_clinical_guidelines","input":"HER2 positive gastric cancer treatment"}'

# 应该返回包含 citations 的 JSON 响应
```

---

## 更新日期

最后更新：2025-11-17

如有问题，请检查：
1. 所有 3 个服务是否正在运行
2. 端口是否被占用
3. 网络连接是否正常
4. API 密钥是否正确配置
