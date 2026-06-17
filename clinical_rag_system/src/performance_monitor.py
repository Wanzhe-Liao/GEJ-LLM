"""
性能监控模块
跟踪系统性能指标、API调用成本和资源使用
"""

import time
import psutil
from typing import Dict, Optional, List
from datetime import datetime
from dataclasses import dataclass, field


@dataclass
class PerformanceMetrics:
    """
    性能指标数据类
    """
    start_time: float = field(default_factory=time.time)
    end_time: Optional[float] = None
    duration_seconds: float = 0.0

    llm_calls: int = 0
    embedding_calls: int = 0
    retrieval_calls: int = 0

    total_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0

    estimated_cost_usd: float = 0.0

    memory_usage_mb: float = 0.0
    cpu_usage_percent: float = 0.0

    success: bool = True
    error_message: str = ""


class PerformanceMonitor:
    """
    性能监控器
    实时跟踪和记录系统性能
    """

    def __init__(self):
        self.current_metrics: Optional[PerformanceMetrics] = None
        self.historical_metrics: List[PerformanceMetrics] = []

        self.pricing = {
            "gpt-4o": {
                "prompt": 2.50 / 1_000_000,
                "completion": 10.00 / 1_000_000
            },
            "gpt-4o-mini": {
                "prompt": 0.150 / 1_000_000,
                "completion": 0.600 / 1_000_000
            },
            "claude-3-5-sonnet": {
                "prompt": 3.00 / 1_000_000,
                "completion": 15.00 / 1_000_000
            },
            "claude-3-haiku": {
                "prompt": 0.25 / 1_000_000,
                "completion": 1.25 / 1_000_000
            },
            "text-embedding-3-large": {
                "prompt": 0.13 / 1_000_000,
                "completion": 0.0
            }
        }

    def start_monitoring(self):
        """
        开始新的监控会话
        """
        self.current_metrics = PerformanceMetrics()

        process = psutil.Process()
        self.current_metrics.memory_usage_mb = process.memory_info().rss / 1024 / 1024
        self.current_metrics.cpu_usage_percent = psutil.cpu_percent(interval=0.1)

    def record_llm_call(self, model: str, prompt_tokens: int, completion_tokens: int):
        """
        记录LLM调用和token使用
        """
        if not self.current_metrics:
            return

        self.current_metrics.llm_calls += 1
        self.current_metrics.prompt_tokens += prompt_tokens
        self.current_metrics.completion_tokens += completion_tokens
        self.current_metrics.total_tokens += (prompt_tokens + completion_tokens)

        if model in self.pricing:
            cost = (
                prompt_tokens * self.pricing[model]["prompt"] +
                completion_tokens * self.pricing[model]["completion"]
            )
            self.current_metrics.estimated_cost_usd += cost

    def record_embedding_call(self, model: str, tokens: int):
        """
        记录Embedding调用
        """
        if not self.current_metrics:
            return

        self.current_metrics.embedding_calls += 1
        self.current_metrics.total_tokens += tokens

        if model in self.pricing:
            cost = tokens * self.pricing[model]["prompt"]
            self.current_metrics.estimated_cost_usd += cost

    def record_retrieval_call(self):
        """
        记录检索调用
        """
        if not self.current_metrics:
            return

        self.current_metrics.retrieval_calls += 1

    def end_monitoring(self, success: bool = True, error_message: str = ""):
        """
        结束监控会话
        """
        if not self.current_metrics:
            return

        self.current_metrics.end_time = time.time()
        self.current_metrics.duration_seconds = (
            self.current_metrics.end_time - self.current_metrics.start_time
        )
        self.current_metrics.success = success
        self.current_metrics.error_message = error_message

        process = psutil.Process()
        self.current_metrics.memory_usage_mb = process.memory_info().rss / 1024 / 1024
        self.current_metrics.cpu_usage_percent = psutil.cpu_percent(interval=0.1)

        self.historical_metrics.append(self.current_metrics)

        return self.current_metrics

    def get_current_metrics(self) -> Optional[PerformanceMetrics]:
        """
        获取当前监控指标
        """
        return self.current_metrics

    def get_summary_statistics(self) -> Dict:
        """
        获取历史统计摘要
        """
        if not self.historical_metrics:
            return {}

        total_calls = len(self.historical_metrics)
        successful_calls = sum(1 for m in self.historical_metrics if m.success)

        avg_duration = sum(m.duration_seconds for m in self.historical_metrics) / total_calls
        total_cost = sum(m.estimated_cost_usd for m in self.historical_metrics)
        total_tokens = sum(m.total_tokens for m in self.historical_metrics)

        return {
            "total_queries": total_calls,
            "successful_queries": successful_calls,
            "success_rate": successful_calls / total_calls * 100,
            "average_duration_seconds": avg_duration,
            "total_cost_usd": total_cost,
            "total_tokens": total_tokens,
            "average_tokens_per_query": total_tokens / total_calls if total_calls > 0 else 0
        }

    def print_current_metrics(self):
        """
        打印当前性能指标
        """
        if not self.current_metrics:
            print("未在监控状态")
            return

        metrics = self.current_metrics

        print("\n" + "="*80)
        print("性能监控报告")
        print("="*80 + "\n")

        print(f"执行时间: {metrics.duration_seconds:.2f} 秒")
        print(f"状态: {'✓ 成功' if metrics.success else '✗ 失败'}")
        if metrics.error_message:
            print(f"错误: {metrics.error_message}")

        print(f"\n{'='*40}")
        print("API调用统计:")
        print(f"{'='*40}")
        print(f"LLM调用: {metrics.llm_calls}")
        print(f"Embedding调用: {metrics.embedding_calls}")
        print(f"检索调用: {metrics.retrieval_calls}")

        print(f"\n{'='*40}")
        print("Token使用:")
        print(f"{'='*40}")
        print(f"总Token: {metrics.total_tokens:,}")
        print(f"输入Token: {metrics.prompt_tokens:,}")
        print(f"输出Token: {metrics.completion_tokens:,}")

        print(f"\n{'='*40}")
        print("成本估算:")
        print(f"{'='*40}")
        print(f"估算成本: ${metrics.estimated_cost_usd:.4f}")

        print(f"\n{'='*40}")
        print("系统资源:")
        print(f"{'='*40}")
        print(f"内存使用: {metrics.memory_usage_mb:.1f} MB")
        print(f"CPU使用: {metrics.cpu_usage_percent:.1f}%")

        print("\n" + "="*80 + "\n")

    def print_summary_statistics(self):
        """
        打印统计摘要
        """
        summary = self.get_summary_statistics()

        if not summary:
            print("暂无历史数据")
            return

        print("\n" + "="*80)
        print("历史统计摘要")
        print("="*80 + "\n")

        print(f"总查询数: {summary['total_queries']}")
        print(f"成功查询数: {summary['successful_queries']}")
        print(f"成功率: {summary['success_rate']:.1f}%")
        print(f"平均执行时间: {summary['average_duration_seconds']:.2f} 秒")
        print(f"总成本: ${summary['total_cost_usd']:.4f}")
        print(f"总Token使用: {summary['total_tokens']:,}")
        print(f"平均Token/查询: {summary['average_tokens_per_query']:.0f}")

        print("\n" + "="*80 + "\n")


global_performance_monitor = PerformanceMonitor()


if __name__ == "__main__":
    monitor = PerformanceMonitor()

    monitor.start_monitoring()

    monitor.record_llm_call("gpt-4o", 1000, 500)
    monitor.record_llm_call("claude-3-5-sonnet", 800, 400)
    monitor.record_embedding_call("text-embedding-3-large", 200)
    monitor.record_retrieval_call()

    time.sleep(1)

    monitor.end_monitoring(success=True)
    monitor.print_current_metrics()