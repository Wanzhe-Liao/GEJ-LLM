"""
L1 MCP 工具定义
封装L2 LangGraph工作流为可被MCP调用的工具
"""

from typing import Optional
from pydantic import BaseModel, Field
from langchain_core.messages import HumanMessage

from src.l2_langgraph_workflow import clinical_workflow_graph
from src.performance_monitor import global_performance_monitor
from src.cache_manager import global_cache
from src.security_utils import InputSanitizer


class ClinicalWorkflowInput(BaseModel):
    """
    MCP工具的输入模式定义
    """
    query: str = Field(
        description="用户关于临床指南的医学问题或查询。例如：'HER2阳性胃癌的推荐治疗方案是什么？'"
    )
    enable_tracing: Optional[bool] = Field(
        default=False,
        description="是否启用LangChain追踪以进行调试和监控"
    )


async def execute_clinical_workflow(query: str, enable_tracing: bool = False) -> str:
    """
    L1 MCP工具：执行完整的临床指南RAG工作流

    此函数被MCP代理调用，通过L2编排层调用L3知识库

    Args:
        query: 用户的医学查询
        enable_tracing: 是否启用追踪

    Returns:
        str: 基于临床指南的综合答案
    """

    print(f"\n{'='*80}")
    print(f"L1 (MCP工具): 收到查询")
    print(f"{'='*80}")
    print(f"查询: {query}")
    print(f"追踪: {'启用' if enable_tracing else '禁用'}")
    print(f"{'='*80}\n")

    sanitized_query = InputSanitizer.sanitize_query(query)

    cached_result = global_cache.get(sanitized_query)
    if cached_result:
        print("\n✓ 从缓存返回结果")
        return cached_result

    global_performance_monitor.start_monitoring()

    try:
        initial_state = {
            "messages": [HumanMessage(content=sanitized_query)],
            "original_query": "",
            "rephrased_query": "",
            "retrieved_documents": [],
            "graded_documents": [],
            "final_generation": "",
            "error_message": ""
        }

        print("L1: 调用L2 LangGraph工作流图谱...\n")

        global_performance_monitor.record_retrieval_call()

        final_state = await clinical_workflow_graph.ainvoke(initial_state)

        result = final_state.get("final_generation", "未能生成答案。")

        global_cache.set(sanitized_query, result)

        global_performance_monitor.end_monitoring(success=True)
        global_performance_monitor.print_current_metrics()

        print(f"\n{'='*80}")
        print(f"L1: 工作流完成")
        print(f"{'='*80}")
        print(f"结果长度: {len(result)} 字符")
        print(f"{'='*80}\n")

        return result

    except Exception as e:
        error_msg = f"L1工具执行错误: {str(e)}"

        global_performance_monitor.end_monitoring(success=False, error_message=error_msg)
        global_performance_monitor.print_current_metrics()

        print(f"\n{'='*80}")
        print(f"ERROR: {error_msg}")
        print(f"{'='*80}\n")
        return f"抱歉，处理您的请求时发生错误：{error_msg}\n\n请检查：\n1. L3 lightRAG服务器是否运行在 http://127.0.0.1:9621\n2. Reranker服务是否运行在 http://localhost:8182\n3. API密钥是否正确配置"


def get_clinical_workflow_tool_definition():
    """
    返回MCP工具定义
    供LangChain Agent使用
    """
    from langchain.tools import StructuredTool

    return StructuredTool.from_function(
        func=execute_clinical_workflow,
        name="clinical_guideline_search",
        description="""
        查询临床指南知识库以获取基于证据的医学建议。

        使用场景：
        - 查询特定癌症类型的治疗方案
        - 了解诊断标准和分期
        - 获取药物使用指导
        - 查询临床试验和研究证据

        此工具会：
        1. 分析和优化查询
        2. 从多个临床指南中检索相关信息
        3. 评估文档相关性
        4. 生成综合性、引用来源的答案

        示例查询：
        - "HER2阳性胃癌的一线治疗推荐是什么？"
        - "非小细胞肺癌的EGFR突变检测方法有哪些？"
        - "III期结直肠癌术后辅助化疗方案？"
        """,
        args_schema=ClinicalWorkflowInput,
        return_direct=True
    )


print("L1 (MCP工具) 已加载")