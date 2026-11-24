"""
MCP HTTP Bridge Server
桥接HTTP请求和MCP标准的stdio协议
支持高并发：使用线程池处理同步的 LangGraph/LightRAG 调用
"""

import asyncio
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import os
import sys

# 添加当前目录到sys.path以导入L2工作流
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(current_dir, 'src'))

from langchain_core.messages import HumanMessage

import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

app = FastAPI(title="MCP HTTP Bridge", version="1.0.0")

# 线程池：支持多个并发请求同时处理
# GLM-4.6 响应较慢，降低并发到 8 避免超时
THREAD_POOL = ThreadPoolExecutor(max_workers=8)

# CORS配置
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class MCPCallRequest(BaseModel):
    tool: str
    input: str

class Citation(BaseModel):
    guidelineName: str
    source: Optional[str] = None
    quote: Optional[str] = None

class MCPCallResponse(BaseModel):
    content: str
    citations: List[Citation] = []

@app.get("/health")
async def health_check():
    """健康检查端点"""
    return {"status": "ok", "service": "MCP HTTP Bridge", "max_workers": THREAD_POOL._max_workers}


def _sync_analyze_query(query: str) -> dict:
    """
    同步执行查询分析（在线程池中运行）
    """
    from l2_langgraph_workflow import node_analyze_and_rephrase_query

    state = {
        "messages": [HumanMessage(content=query)],
        "original_query": "",
        "rephrased_query": "",
        "retrieved_documents": [],
        "graded_documents": [],
        "final_generation": "",
        "citations": [],
        "error_message": ""
    }

    result = node_analyze_and_rephrase_query(state)

    if result.get("rephrased_query"):
        content = f"""Query Analysis Result

Original Query: {query}
Rephrased Query: {result['rephrased_query']}

This is a substantive medical question optimized for guideline search."""
        return {"content": content, "citations": []}
    elif result.get("final_generation"):
        return {"content": result['final_generation'], "citations": []}
    else:
        raise Exception(result.get('error_message', 'Unknown error in analyze'))


def _sync_query_guidelines(query: str) -> dict:
    """
    同步执行完整 RAG 流程（在线程池中运行）
    """
    import asyncio
    from l2_langgraph_workflow import create_clinical_workflow

    workflow = create_clinical_workflow()

    initial_state = {
        "messages": [HumanMessage(content=query)],
        "original_query": query,
        "rephrased_query": "",
        "retrieved_documents": [],
        "graded_documents": [],
        "final_generation": "",
        "citations": [],
        "error_message": ""
    }

    print("执行完整工作流...")
    
    # 在线程中创建新的事件循环来运行异步工作流
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        final_state = loop.run_until_complete(workflow.ainvoke(initial_state))
    finally:
        loop.close()

    print(f"工作流完成")
    print(f"final_generation: {len(final_state.get('final_generation', ''))} 字符")
    print(f"citations: {len(final_state.get('citations', []))} 条\n")

    citations = final_state.get('citations', [])
    citation_list = [
        {
            "guidelineName": c['guidelineName'],
            "source": c.get('source', ''),
            "quote": c.get('quote', '')
        }
        for c in citations
    ]

    return {
        "content": final_state.get('final_generation', 'No content generated'),
        "citations": citation_list
    }


@app.post("/mcp/call", response_model=MCPCallResponse)
async def mcp_call(request: MCPCallRequest):
    """
    MCP工具调用端点
    使用线程池并发处理，支持多个请求同时执行
    """
    try:
        tool_name = request.tool
        query = request.input

        print(f"\n{'='*60}")
        print(f"MCP HTTP Bridge: 收到调用 (线程池并发模式)")
        print(f"工具: {tool_name}")
        print(f"查询: {query[:100]}...")
        print(f"{'='*60}\n")

        loop = asyncio.get_event_loop()

        if tool_name == "analyze_medical_query":
            # 在线程池中执行同步分析
            result = await loop.run_in_executor(
                THREAD_POOL,
                _sync_analyze_query,
                query
            )
            return MCPCallResponse(
                content=result["content"],
                citations=[]
            )

        elif tool_name == "query_clinical_guidelines":
            # 在线程池中执行完整 RAG
            result = await loop.run_in_executor(
                THREAD_POOL,
                _sync_query_guidelines,
                query
            )
            citation_objects = [
                Citation(
                    guidelineName=c['guidelineName'],
                    source=c.get('source', ''),
                    quote=c.get('quote', '')
                )
                for c in result["citations"]
            ]
            return MCPCallResponse(
                content=result["content"],
                citations=citation_objects
            )

        else:
            raise HTTPException(
                status_code=404,
                detail=f"Unknown tool: {tool_name}"
            )

    except Exception as e:
        print(f"错误: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn

    print("\n" + "="*60)
    print("启动 MCP HTTP Bridge Server")
    print("端口: 8787")
    print("="*60 + "\n")

    # Windows 不支持多 workers，使用单 worker 但增加超时设置
    # 前端已经实现了并发控制（最多 2 个并发请求）
    uvicorn.run(app, host="0.0.0.0", port=8787, log_level="info", timeout_keep_alive=300)
