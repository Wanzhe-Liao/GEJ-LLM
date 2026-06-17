"""
L2 LangGraph 工作流定义
实现纠正型RAG (Corrective RAG) 流程
"""

import os
import re
import httpx
import json
import operator
from typing import TypedDict, Annotated, List, Literal, Optional
from dotenv import load_dotenv

from langchain_openai import ChatOpenAI
from langchain_core.messages import AnyMessage, HumanMessage, AIMessage, SystemMessage
from langgraph.graph import StateGraph, START, END

load_dotenv(dotenv_path='config/.env')

import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')


class ClinicalWorkflowState(TypedDict):
    """
    临床RAG工作流的L2状态
    在所有节点之间传递的共享状态
    """
    messages: Annotated[List[AnyMessage], operator.add]
    original_query: str
    rephrased_query: str
    retrieved_documents: List[dict]
    graded_documents: List[dict]
    final_generation: str
    citations: List[dict]
    error_message: str


LLM_TIMEOUT = int(os.getenv('HTTP_TIMEOUT', '60'))
MAX_RETRIES = int(os.getenv('MAX_RETRIES', '3'))

# DeepSeek 官方 API 配置
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"

llm_analysis_client = ChatOpenAI(
    model="deepseek-reasoner",  # DeepSeek Reasoner
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
    timeout=LLM_TIMEOUT,
    max_retries=MAX_RETRIES
)

llm_synthesis_client = ChatOpenAI(
    model="deepseek-reasoner",  # DeepSeek Reasoner
    api_key=DEEPSEEK_API_KEY,
    base_url=DEEPSEEK_BASE_URL,
    timeout=LLM_TIMEOUT,
    max_retries=MAX_RETRIES
)

LIGHTRAG_API_URL = "http://127.0.0.1:9621/api/v1/query"
httpx_client = httpx.Client(timeout=600.0)  # 10分钟超时
LOCAL_CHUNK_STORE_PATH = os.getenv("LOCAL_CHUNK_STORE", os.path.join("rag_storage", "kv_store_text_chunks.json"))
_local_chunk_cache: Optional[List[dict]] = None


def _load_local_chunks() -> List[dict]:
    global _local_chunk_cache
    if _local_chunk_cache is not None:
        return _local_chunk_cache

    try:
        with open(LOCAL_CHUNK_STORE_PATH, "r", encoding="utf-8") as f:
            raw_chunks = json.load(f)

        cache = []
        for chunk_id, payload in raw_chunks.items():
            if not isinstance(payload, dict):
                continue
            payload_copy = payload.copy()
            payload_copy["chunk_id"] = chunk_id
            cache.append(payload_copy)

        _local_chunk_cache = cache
        print(f"[Fallback] 已加载 {len(cache)} 个本地chunk用于回退检索")
        return cache
    except FileNotFoundError:
        print(f"[Fallback] 本地chunk文件不存在: {LOCAL_CHUNK_STORE_PATH}")
    except Exception as e:
        print(f"[Fallback] 加载本地chunk文件失败: {e}")

    _local_chunk_cache = []
    return _local_chunk_cache


def _fallback_retrieve_from_local_store(query: str, limit: int = 5) -> List[dict]:
    chunks = _load_local_chunks()
    if not chunks:
        return []

    query_terms = [term.lower() for term in re.findall(r"\w+", query) if len(term) > 2]
    if not query_terms:
        query_terms = [query.lower()]

    ranked: List[tuple[int, dict]] = []
    for chunk in chunks:
        content = chunk.get("content", "")
        if not content:
            continue
        lowered = content.lower()
        score = sum(lowered.count(term) for term in query_terms)
        if score <= 0:
            continue
        ranked.append((score, chunk))

    if not ranked:
        return []

    ranked.sort(key=lambda item: item[0], reverse=True)

    fallback_docs: List[dict] = []
    for score, chunk in ranked[:limit]:
        file_path = chunk.get("file_path", "")
        source_filename = chunk.get("source_filename")
        if not source_filename:
            source_filename = os.path.basename(file_path) if file_path else "LocalGuideline"

        fallback_docs.append({
            "content": chunk.get("content", ""),
            "source_filename": source_filename,
            "file_path": file_path,
            "reference_id": chunk.get("reference_id"),
            "chunk_id": chunk.get("chunk_id"),
            "score": float(score)
        })

    return fallback_docs


def node_analyze_and_rephrase_query(state: ClinicalWorkflowState) -> dict:
    """
    L2节点：分析用户查询
    实质性问题会被改写为优化的搜索查询
    """
    try:
        user_query = state["messages"][-1].content

        system_prompt = """You are a clinical query analysis expert. Your task is to analyze the user's query about clinical guidelines.

1. Determine if the query is a simple greeting or a substantive clinical question.
2. If it is a substantive question, rephrase it into an optimal, keyword-rich search query for a vector database.
3. Extract key medical terms, conditions, treatments, or guidelines mentioned.

Respond ONLY with a JSON object in this exact format:
{"is_substantive": true/false, "rephrased_query": "your optimized query here" or "N/A"}

Example:
User: "What is the treatment for stage 3 gastric cancer?"
Response: {"is_substantive": true, "rephrased_query": "stage 3 gastric cancer treatment guidelines chemotherapy surgery options"}
"""

        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_query)
        ]

        response = llm_analysis_client.invoke(messages)

        try:
            analysis = json.loads(response.content)
        except json.JSONDecodeError:
            content = response.content.strip()
            if content.startswith("```json"):
                content = content[7:-3].strip()
            elif content.startswith("```"):
                content = content[3:-3].strip()
            analysis = json.loads(content)

        if not analysis.get("is_substantive"):
            return {
                "final_generation": "Hello! I'm here to help you with clinical guidelines. Please ask me a specific medical question.",
                "error_message": "Query was not substantive."
            }

        return {
            "original_query": user_query,
            "rephrased_query": analysis["rephrased_query"],
            "messages": [AIMessage(content=f"Query analyzed and rephrased: {analysis['rephrased_query']}")]
        }

    except Exception as e:
        user_query = state["messages"][-1].content if state.get("messages") else ""
        print(f"[Fallback] analyze_query 调用失败，使用原始查询: {e}")
        fallback_query = user_query.strip() or "clinical guidelines query"
        return {
            "original_query": user_query,
            "rephrased_query": fallback_query,
            "messages": [AIMessage(content=f"Fallback rephrase used due to error: {fallback_query}")]
        }


def node_retrieve_from_lightrag(state: ClinicalWorkflowState) -> dict:
    """
    L2节点：调用L3 lightRAG服务器API
    """
    try:
        import re
        query = state["rephrased_query"]
        print(f"\n{'='*60}")
        print(f"L2: 调用L3 lightRAG服务")
        print(f"查询: {query}")
        print(f"{'='*60}\n")

        response = httpx_client.post(
            LIGHTRAG_API_URL,
            json={
                "query": query,
                "mode": "mix"
            }
        )
        response.raise_for_status()
        data = response.json()

        answer = data.get("answer", "")
        documents = data.get("documents", [])

        if not documents:
            structured = data.get("data") or {}
            references = structured.get("references", []) if isinstance(structured, dict) else []
            ref_lookup = {
                ref.get("reference_id"): ref.get("file_path", "")
                for ref in references
                if isinstance(ref, dict) and ref.get("reference_id")
            }

            chunk_entries = structured.get("chunks", []) if isinstance(structured, dict) else []
            for idx, chunk in enumerate(chunk_entries, 1):
                if not isinstance(chunk, dict):
                    continue
                ref_id = chunk.get("reference_id")
                file_path = chunk.get("file_path") or ref_lookup.get(ref_id, "")
                source_filename = chunk.get("source_filename")
                if not source_filename:
                    source_filename = os.path.basename(file_path) if file_path else f"Guideline_{idx}"

                documents.append({
                    "content": chunk.get("content", ""),
                    "source_filename": source_filename,
                    "file_path": file_path,
                    "reference_id": ref_id,
                    "chunk_id": chunk.get("chunk_id"),
                    "score": chunk.get("score", 0.0)
                })

        if not documents:
            fallback_docs = _fallback_retrieve_from_local_store(query, limit=6)
            if fallback_docs:
                print(f"[Fallback] 使用本地chunk store补充 {len(fallback_docs)} 个文档")
                documents = fallback_docs

        print(f"L3返回答案长度: {len(answer)} 字符")
        print(f"检索到 {len(documents)} 个文档\n")

        citations = []

        if answer and "### References" in answer:
            ref_section = answer.split("### References")[1] if "### References" in answer else ""
            ref_pattern = r'-\s*\[(\d+)\]\s*(.+?)\.pdf'
            matches = re.findall(ref_pattern, ref_section)

            for ref_num, guideline_name in matches:
                citation = {
                    "guidelineName": f"{guideline_name}.pdf",
                    "source": f"{guideline_name}.pdf",
                    "quote": f"Reference [{ref_num}] cited in LightRAG answer"
                }
                citations.append(citation)

            print(f"从 ### References 中提取了 {len(citations)} 条引用\n")

        if len(citations) == 0 and answer:
            pdf_pattern = r'(?:根据|参考|引用|来源于)?[\s"\'《]*([A-Z][A-Za-z0-9\s&_-]+(?:Guidelines?|Guideline|Clinical Practice|Consensus|Recommendation|NCCN|ESMO|ASCO|CSCO|AJCC)[A-Za-z0-9\s\(\)&_-]*)\.pdf'
            pdf_matches = re.findall(pdf_pattern, answer)

            guideline_pattern = r'(?:NCCN|ESMO|ASCO|CSCO|AJCC|WHO|ACS)\s+[A-Za-z0-9\s]+'
            guideline_matches = re.findall(guideline_pattern, answer)

            all_guidelines = set()
            for match in pdf_matches:
                all_guidelines.add(match.strip() + ".pdf")
            for match in guideline_matches:
                all_guidelines.add(match.strip())

            for idx, guideline in enumerate(sorted(all_guidelines), 1):
                citation = {
                    "guidelineName": guideline if guideline.endswith('.pdf') else f"{guideline}",
                    "source": guideline,
                    "quote": f"Referenced in LightRAG analysis"
                }
                citations.append(citation)

            print(f"从答案文本中提取了 {len(citations)} 条潜在引用\n")

        if len(citations) > 0:
            return {
                "final_generation": answer,
                "citations": citations,
                "retrieved_documents": []
            }
        else:
            return {"retrieved_documents": documents}

    except httpx.HTTPError as e:
        error_msg = f"HTTP错误调用lightRAG: {str(e)}"
        print(f"ERROR: {error_msg}")
        return {"error_message": error_msg}
    except Exception as e:
        error_msg = f"调用lightRAG时出错: {str(e)}"
        print(f"ERROR: {error_msg}")
        return {"error_message": error_msg}


def node_grade_document_relevance(state: ClinicalWorkflowState) -> dict:
    """
    L2节点：纠正型RAG - 使用LLM评估文档相关性
    """
    try:
        query = state["original_query"]
        documents = state["retrieved_documents"]

        if not documents:
            return {
                "graded_documents": [],
                "error_message": "No documents retrieved from lightRAG."
            }

        print(f"\n{'='*60}")
        print(f"L2: 评估文档相关性")
        print(f"原始查询: {query}")
        print(f"文档数量: {len(documents)}")
        print(f"{'='*60}\n")

        system_prompt = """You are a relevance grader for medical documents.
Given a user query and a document chunk, determine if the document is relevant to answering the query.

Respond with ONLY one word: 'relevant' or 'irrelevant'

Query: {query}
---
Document: {document_content}
"""

        graded_docs = []
        for idx, doc in enumerate(documents, 1):
            doc_content = doc.get('content', '')[:1000]

            prompt = system_prompt.format(
                query=query,
                document_content=doc_content
            )

            response = llm_analysis_client.invoke([HumanMessage(content=prompt)])

            is_relevant = 'relevant' in response.content.lower()

            if is_relevant:
                graded_docs.append(doc)
                print(f"✓ 文档 {idx}: 相关")
            else:
                print(f"✗ 文档 {idx}: 不相关")

        print(f"\n相关文档: {len(graded_docs)}/{len(documents)}\n")

        if not graded_docs:
            return {
                "graded_documents": [],
                "error_message": "No relevant documents found after grading."
            }

        return {"graded_documents": graded_docs}

    except Exception as e:
        return {"error_message": f"Error in grade_document_relevance: {str(e)}"}


def node_generate_final_answer(state: ClinicalWorkflowState) -> dict:
    """
    L2节点：使用分级的相关文档综合最终答案
    """
    try:
        query = state["original_query"]
        documents = state["graded_documents"]

        print(f"\n{'='*60}")
        print(f"L2: 生成最终答案")
        print(f"使用 {len(documents)} 个相关文档")
        print(f"{'='*60}\n")

        context_parts = []
        for idx, doc in enumerate(documents, 1):
            source = doc.get('source_filename', 'Unknown')
            content = doc.get('content', '')
            context_parts.append(f"[Source {idx}: {source}]\n{content}\n")

        context_str = "\n---\n".join(context_parts)

        system_prompt = f"""You are a clinical assistant providing evidence-based answers from clinical guidelines.

INSTRUCTIONS:
1. Answer the user's query based ONLY on the provided context from clinical guidelines
2. Cite your sources using [Source X] format
3. If the answer cannot be found in the context, clearly state that
4. Provide specific recommendations when available
5. Use clear, professional medical language

CONTEXT FROM CLINICAL GUIDELINES:
{context_str}

USER QUERY:
{query}

Provide a comprehensive, evidence-based answer:"""

        response = llm_synthesis_client.invoke([HumanMessage(content=system_prompt)])

        final_answer = response.content

        print(f"答案已生成 (长度: {len(final_answer)} 字符)\n")

        citations = []
        for idx, doc in enumerate(documents, 1):
            citation = {
                "guidelineName": doc.get('source_filename', f'Unknown Source {idx}'),
                "source": doc.get('source_filename', ''),
                "quote": doc.get('content', '')[:500]
            }
            citations.append(citation)

        print(f"提取了 {len(citations)} 条引用信息\n")

        return {
            "final_generation": final_answer,
            "citations": citations
        }

    except Exception as e:
        return {"error_message": f"Error in generate_final_answer: {str(e)}"}


def node_handle_error(state: ClinicalWorkflowState) -> dict:
    """
    L2节点：统一的错误处理终端节点
    """
    err = state.get("error_message", "An unknown error occurred.")

    print(f"\n{'='*60}")
    print(f"ERROR: {err}")
    print(f"{'='*60}\n")

    return {
        "final_generation": f"I apologize, but I encountered an error while processing your request: {err}\n\nPlease try again or rephrase your query."
    }


def route_after_analysis(state: ClinicalWorkflowState) -> Literal["retrieve", "end_with_error", "END"]:
    """
    条件路由：分析查询后决定下一步
    """
    if state.get("error_message"):
        if "not substantive" in state["error_message"]:
            return END
        return "end_with_error"
    return "retrieve"


def route_after_grading(state: ClinicalWorkflowState) -> Literal["generate_answer", "end_with_error"]:
    """
    条件路由：评级文档后决定下一步
    """
    if state.get("error_message"):
        return "end_with_error"
    return "generate_answer"


def route_after_retrieve(state: ClinicalWorkflowState) -> Literal["grade_docs", "END"]:
    """
    条件路由：检索后决定下一步
    如果L3已经返回了完整答案和citations，直接结束
    """
    if state.get("final_generation") and state.get("citations"):
        print("L3已返回完整答案和citations，跳过评分和生成步骤\n")
        return END
    return "grade_docs"


def get_clinical_workflow_graph():
    """
    构建并编译临床工作流图谱
    """
    builder = StateGraph(ClinicalWorkflowState)

    builder.add_node("analyze_query", node_analyze_and_rephrase_query)
    builder.add_node("retrieve_docs", node_retrieve_from_lightrag)
    builder.add_node("grade_docs", node_grade_document_relevance)
    builder.add_node("generate_answer", node_generate_final_answer)
    builder.add_node("error_node", node_handle_error)

    builder.set_entry_point("analyze_query")

    builder.add_conditional_edges(
        "analyze_query",
        route_after_analysis,
        {
            "retrieve": "retrieve_docs",
            "end_with_error": "error_node",
            END: END
        }
    )

    builder.add_conditional_edges(
        "retrieve_docs",
        route_after_retrieve,
        {
            "grade_docs": "grade_docs",
            END: END
        }
    )

    builder.add_conditional_edges(
        "grade_docs",
        route_after_grading,
        {
            "generate_answer": "generate_answer",
            "end_with_error": "error_node"
        }
    )

    builder.add_edge("generate_answer", END)
    builder.add_edge("error_node", END)

    return builder.compile()


clinical_workflow_graph = get_clinical_workflow_graph()


def create_clinical_workflow():
    """
    创建并返回临床工作流实例
    供外部调用（如HTTP桥接服务）
    """
    return get_clinical_workflow_graph()

print("L2 (LangGraph) 工作流图谱已编译")
