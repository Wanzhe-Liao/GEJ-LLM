"""
缓存管理模块
实现查询结果缓存以提升性能和降低成本
"""

import hashlib
import json
import time
from typing import Optional, Dict, Any
from pathlib import Path


class SimpleCache:
    """
    简单的内存缓存实现
    用于缓存查询结果
    """

    def __init__(self, max_size: int = 100, ttl_seconds: int = 3600):
        """
        初始化缓存

        Args:
            max_size: 最大缓存条目数
            ttl_seconds: 缓存生存时间（秒）
        """
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self.cache: Dict[str, Dict[str, Any]] = {}
        self.access_times: Dict[str, float] = {}

    def _generate_cache_key(self, query: str) -> str:
        """
        生成缓存键
        使用查询的SHA256哈希
        """
        normalized_query = query.lower().strip()
        return hashlib.sha256(normalized_query.encode('utf-8')).hexdigest()

    def _is_expired(self, cache_key: str) -> bool:
        """
        检查缓存是否过期
        """
        if cache_key not in self.access_times:
            return True

        elapsed_time = time.time() - self.access_times[cache_key]
        return elapsed_time > self.ttl_seconds

    def _evict_oldest(self):
        """
        淘汰最旧的缓存条目
        """
        if not self.access_times:
            return

        oldest_key = min(self.access_times, key=self.access_times.get)
        del self.cache[oldest_key]
        del self.access_times[oldest_key]

    def get(self, query: str) -> Optional[str]:
        """
        从缓存获取结果

        Args:
            query: 用户查询

        Returns:
            缓存的结果，如果未命中或过期则返回None
        """
        cache_key = self._generate_cache_key(query)

        if cache_key not in self.cache:
            return None

        if self._is_expired(cache_key):
            del self.cache[cache_key]
            del self.access_times[cache_key]
            return None

        self.access_times[cache_key] = time.time()

        cache_entry = self.cache[cache_key]
        print(f"\n✓ 缓存命中: {cache_entry['query'][:50]}...")

        return cache_entry['result']

    def set(self, query: str, result: str):
        """
        设置缓存

        Args:
            query: 用户查询
            result: 查询结果
        """
        cache_key = self._generate_cache_key(query)

        if len(self.cache) >= self.max_size:
            self._evict_oldest()

        self.cache[cache_key] = {
            'query': query,
            'result': result,
            'timestamp': time.time()
        }
        self.access_times[cache_key] = time.time()

        print(f"\n✓ 缓存已保存: {query[:50]}...")

    def clear(self):
        """
        清空缓存
        """
        self.cache.clear()
        self.access_times.clear()
        print("✓ 缓存已清空")

    def get_statistics(self) -> Dict[str, Any]:
        """
        获取缓存统计信息
        """
        return {
            'total_entries': len(self.cache),
            'max_size': self.max_size,
            'ttl_seconds': self.ttl_seconds,
            'usage_percent': (len(self.cache) / self.max_size * 100) if self.max_size > 0 else 0
        }

    def print_statistics(self):
        """
        打印缓存统计
        """
        stats = self.get_statistics()

        print("\n" + "="*80)
        print("缓存统计")
        print("="*80 + "\n")
        print(f"缓存条目: {stats['total_entries']}/{stats['max_size']}")
        print(f"使用率: {stats['usage_percent']:.1f}%")
        print(f"TTL: {stats['ttl_seconds']} 秒")
        print("\n" + "="*80 + "\n")


class PersistentCache(SimpleCache):
    """
    持久化缓存实现
    将缓存保存到磁盘
    """

    def __init__(self, cache_file: str = ".cache/query_cache.json", **kwargs):
        super().__init__(**kwargs)
        self.cache_file = Path(cache_file)
        self._load_from_disk()

    def _load_from_disk(self):
        """
        从磁盘加载缓存
        """
        if not self.cache_file.exists():
            return

        try:
            with open(self.cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self.cache = data.get('cache', {})
                self.access_times = data.get('access_times', {})

            expired_keys = [k for k in self.cache.keys() if self._is_expired(k)]
            for key in expired_keys:
                del self.cache[key]
                if key in self.access_times:
                    del self.access_times[key]

            print(f"✓ 从磁盘加载缓存: {len(self.cache)} 条目")

        except Exception as e:
            print(f"⚠ 加载缓存失败: {str(e)}")
            self.cache = {}
            self.access_times = {}

    def _save_to_disk(self):
        """
        保存缓存到磁盘
        """
        try:
            self.cache_file.parent.mkdir(parents=True, exist_ok=True)

            with open(self.cache_file, 'w', encoding='utf-8') as f:
                json.dump({
                    'cache': self.cache,
                    'access_times': self.access_times
                }, f, ensure_ascii=False, indent=2)

        except Exception as e:
            print(f"⚠ 保存缓存失败: {str(e)}")

    def set(self, query: str, result: str):
        """
        设置缓存并保存到磁盘
        """
        super().set(query, result)
        self._save_to_disk()

    def clear(self):
        """
        清空缓存并删除磁盘文件
        """
        super().clear()
        if self.cache_file.exists():
            self.cache_file.unlink()
        print("✓ 缓存文件已删除")


global_cache = SimpleCache(max_size=50, ttl_seconds=1800)


if __name__ == "__main__":
    cache = SimpleCache(max_size=3, ttl_seconds=5)

    cache.set("What is gastric cancer?", "Gastric cancer is a type of cancer...")
    cache.set("Treatment for HER2+ cancer?", "HER2-positive cancers can be treated...")

    result = cache.get("What is gastric cancer?")
    print(f"Result: {result[:50]}...")

    cache.print_statistics()

    print("\nWaiting 6 seconds for expiration...")
    time.sleep(6)

    result = cache.get("What is gastric cancer?")
    print(f"After expiration: {result}")