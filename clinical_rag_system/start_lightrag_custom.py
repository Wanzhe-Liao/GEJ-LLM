"""
直接使用Python API启动LightRAG服务
可以完全控制所有参数，包括embedding维度
"""

import os
import sys
import io
import uvicorn
from dotenv import load_dotenv
from lightrag import LightRAG
from lightrag.lightrag import EmbeddingFunc
from lightrag.operate import QueryParam
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

load_dotenv(dotenv_path='config/lightrag.env')

current_dir = os.path.dirname(os.path.abspath(__file__))
WORKING_DIR = os.path.abspath(
    os.getenv('WORKING_DIRECTORY', os.path.join(current_dir, 'rag_storage'))
)
HOST = os.getenv('HOST', '127.0.0.1')
PORT = int(os.getenv('PORT', '9621'))
EMBEDDING_DIM = int(os.getenv('EMBEDDING_DIMENSIONS', '3072'))

print(f"\n{'='*70}")
print(f"LightRAG 服务启动配置")
print(f"{'='*70}")
print(f"工作目录: {WORKING_DIR}")
print(f"Embedding维度: {EMBEDDING_DIM}")
print(f"Embedding模型: {os.getenv('EMBEDDING_MODEL')}")
print(f"LLM模型: {os.getenv('LLM_MODEL')}")
print(f"API Base: {os.getenv('OPENAI_API_BASE')}")
print(f"服务地址: http://{HOST}:{PORT}")
print(f"{'='*70}\n")

async def embedding_func(texts: list[str]) -> list[list[float]]:
    """OpenAI embedding函数（异步版本）"""
    import openai
    client = openai.AsyncClient(
        api_key=os.getenv('OPENAI_API_KEY'),
        base_url=os.getenv('OPENAI_API_BASE')
    )

    response = await client.embeddings.create(
        model=os.getenv('EMBEDDING_MODEL', 'text-embedding-3-large'),
        input=texts,
        dimensions=EMBEDDING_DIM
    )

    return [data.embedding for data in response.data]

async def llm_model_func(prompt, **kwargs):
    """LLM模型函数"""
    import openai
    client = openai.AsyncClient(
        api_key=os.getenv('OPENAI_API_KEY'),
        base_url=os.getenv('OPENAI_API_BASE')
    )

    # 过滤掉OpenAI不支持的参数
    unsupported_params = ['hashing_kv', 'keyword_extraction', 'response_format_type', 'system_prompt', 'history_messages', 'enable_cot']
    filtered_kwargs = {k: v for k, v in kwargs.items() if k not in unsupported_params}

    # 如果有system_prompt，将其转换为messages格式
    if 'system_prompt' in kwargs:
        messages = [{"role": "system", "content": kwargs['system_prompt']},
                   {"role": "user", "content": prompt}]
    else:
        messages = [{"role": "user", "content": prompt}]

    hist = kwargs.get('history_messages')
    if hist:
        if isinstance(hist, list):
            messages = hist + messages
        elif isinstance(hist, str):
            messages = [{"role": "system", "content": hist}] + messages

    response = await client.chat.completions.create(
        model=os.getenv('LLM_MODEL', 'deepseek-v3.2-exp'),
        messages=messages,
        **filtered_kwargs
    )

    content = response.choices[0].message.content
    if content is None:
        content = ""
    return content

print("初始化 LightRAG...")
rag = LightRAG(
    working_dir=WORKING_DIR,
    llm_model_func=llm_model_func,
    embedding_func=EmbeddingFunc(
        embedding_dim=EMBEDDING_DIM,
        max_token_size=8192,
        func=embedding_func
    ),
    entity_extract_max_gleaning=0,
    default_llm_timeout=120,
    chunk_token_size=1200,
    chunk_overlap_token_size=200,
    llm_model_max_async=6
)

print("加载现有知识图谱...")
import asyncio
asyncio.run(rag.initialize_storages())
print(f"[SUCCESS] LightRAG初始化成功，embedding维度: {EMBEDDING_DIM}\n")

app = FastAPI(title="Clinical RAG API")

class QueryRequest(BaseModel):
    query: str
    mode: str = "mix"

class QueryResponse(BaseModel):
    answer: str
    documents: list = []

@app.get("/health")
async def health():
    return {"status": "healthy", "embedding_dim": EMBEDDING_DIM}

@app.post("/api/v1/query")
async def query(request: QueryRequest):
    """查询接口"""
    print(f"\n{{'='*60}}")
    print(f"[L3] 收到查询请求")
    print(f"查询: {request.query[:100]}...")
    print(f"模式: {request.mode}")
    print(f"{{'='*60}}\n")

    try:
        rag_result = await rag.aquery_llm(
            request.query,
            param=QueryParam(mode=request.mode, stream=False)
        )

        if not isinstance(rag_result, dict):
            raise ValueError("Unexpected response format from LightRAG")

        llm_response = rag_result.get("llm_response", {})
        answer = llm_response.get("content", "")

        if not answer:
            answer = rag_result.get("message", "")

        if not answer:
            print(f"[L3] 警告: 查询返回空结果")
            answer = "I apologize, but I encountered an error while processing your request.\n\nPlease try again or rephrase your query."

        structured_data = rag_result.get("data", {}) or {}
        references = structured_data.get("references", []) or []
        reference_lookup = {
            ref.get("reference_id"): ref.get("file_path", "")
            for ref in references
            if ref.get("reference_id")
        }

        chunks = structured_data.get("chunks", []) or []
        documents = []

        for idx, chunk in enumerate(chunks, 1):
            ref_id = chunk.get("reference_id")
            file_path = chunk.get("file_path") or reference_lookup.get(ref_id, "")
            source_filename = os.path.basename(file_path) if file_path else f"Guideline_{idx}"

            documents.append({
                "content": chunk.get("content", ""),
                "source_filename": source_filename,
                "file_path": file_path,
                "reference_id": ref_id,
                "chunk_id": chunk.get("chunk_id")
            })

        print(f"[L3] 检索到 {len(documents)} 个文档块\n")

        return QueryResponse(
            answer=answer,
            documents=documents
        )
    except Exception as e:
        print(f"[L3] 错误: {str(e)}\n")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/")
async def root():
    return {
        "message": "Clinical RAG API",
        "docs": f"http://{HOST}:{PORT}/docs",
        "embedding_dim": EMBEDDING_DIM
    }

if __name__ == "__main__":
    print(f"\n[STARTING] 启动服务器...")
    print(f"[DOCS] API文档: http://{HOST}:{PORT}/docs")
    print(f"[API] 临床查询: POST http://{HOST}:{PORT}/api/v1/query")
    print(f"\n按 Ctrl+C 停止服务器\n")

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="info"
    )
