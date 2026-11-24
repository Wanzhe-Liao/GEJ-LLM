"""
安全工具模块
实现API密钥管理、配置验证和安全最佳实践
"""

import os
import stat
from typing import Dict, List, Tuple
from pathlib import Path


class SecurityValidator:
    """
    安全验证器
    检查配置文件权限、API密钥安全性等
    """

    @staticmethod
    def validate_config_file_permissions(file_path: str) -> Tuple[bool, str]:
        """
        验证配置文件权限（Unix系统）
        Windows系统跳过此检查
        """
        if os.name == 'nt':
            return True, "Windows系统跳过文件权限检查"

        try:
            file_stat = os.stat(file_path)
            file_mode = stat.S_IMODE(file_stat.st_mode)

            if file_mode & (stat.S_IRWXG | stat.S_IRWXO):
                return False, f"配置文件 {file_path} 权限过于宽松，应设置为600"

            return True, "配置文件权限安全"

        except FileNotFoundError:
            return False, f"配置文件不存在: {file_path}"
        except Exception as e:
            return False, f"权限检查失败: {str(e)}"

    @staticmethod
    def validate_api_key_format(api_key: str, key_type: str = "openai") -> Tuple[bool, str]:
        """
        验证API密钥格式
        """
        if not api_key or api_key in ["sk-XXXXXX", "sk-ant-XXXXXX"]:
            return False, f"{key_type} API密钥未配置或使用模板值"

        if key_type == "openai":
            if not api_key.startswith("sk-"):
                return False, "OpenAI API密钥格式错误，应以'sk-'开头"
            if len(api_key) < 20:
                return False, "OpenAI API密钥长度不足"

        elif key_type == "anthropic":
            if not api_key.startswith("sk-ant-"):
                return False, "Anthropic API密钥格式错误，应以'sk-ant-'开头"
            if len(api_key) < 30:
                return False, "Anthropic API密钥长度不足"

        return True, f"{key_type} API密钥格式有效"

    @staticmethod
    def mask_api_key(api_key: str) -> str:
        """
        脱敏API密钥用于日志记录
        """
        if not api_key or len(api_key) < 10:
            return "***"

        return f"{api_key[:10]}...{api_key[-4:]}"

    @staticmethod
    def check_environment_security() -> Dict[str, bool]:
        """
        全面的环境安全检查
        """
        results = {}

        openai_key = os.getenv("OPENAI_API_KEY", "")
        anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")

        results["openai_key_valid"] = SecurityValidator.validate_api_key_format(
            openai_key, "openai"
        )[0]
        results["anthropic_key_valid"] = SecurityValidator.validate_api_key_format(
            anthropic_key, "anthropic"
        )[0]

        config_path = "config/.env"
        if os.path.exists(config_path):
            results["config_permissions_ok"] = SecurityValidator.validate_config_file_permissions(
                config_path
            )[0]
        else:
            results["config_permissions_ok"] = False

        return results


class InputSanitizer:
    """
    输入清洗器
    防止注入攻击和恶意输入
    """

    @staticmethod
    def sanitize_query(query: str, max_length: int = 2000) -> str:
        """
        清洗用户查询
        限制长度并移除潜在的恶意内容
        """
        if not query:
            return ""

        sanitized = query.strip()

        sanitized = sanitized[:max_length]

        dangerous_patterns = [
            "<script>",
            "</script>",
            "javascript:",
            "onerror=",
            "onclick="
        ]

        for pattern in dangerous_patterns:
            sanitized = sanitized.replace(pattern, "")

        return sanitized

    @staticmethod
    def validate_file_path(file_path: str, allowed_dirs: List[str]) -> Tuple[bool, str]:
        """
        验证文件路径防止路径遍历攻击
        """
        try:
            resolved_path = Path(file_path).resolve()

            for allowed_dir in allowed_dirs:
                allowed_path = Path(allowed_dir).resolve()
                if resolved_path.is_relative_to(allowed_path):
                    return True, "文件路径有效"

            return False, "文件路径不在允许的目录中"

        except Exception as e:
            return False, f"路径验证失败: {str(e)}"


class RateLimiter:
    """
    简单的请求速率限制器
    防止API滥用
    """

    def __init__(self, max_requests_per_minute: int = 60):
        self.max_requests = max_requests_per_minute
        self.requests = []

    def check_rate_limit(self) -> Tuple[bool, str]:
        """
        检查是否超过速率限制
        """
        import time
        current_time = time.time()

        self.requests = [req for req in self.requests if current_time - req < 60]

        if len(self.requests) >= self.max_requests:
            return False, f"超过速率限制 ({self.max_requests} 请求/分钟)"

        self.requests.append(current_time)
        return True, "速率正常"


def run_security_audit():
    """
    运行完整的安全审计
    """
    print("\n" + "="*80)
    print("安全审计报告")
    print("="*80 + "\n")

    validator = SecurityValidator()
    security_status = validator.check_environment_security()

    all_secure = True

    for check, passed in security_status.items():
        status = "✓" if passed else "✗"
        print(f"{status} {check}: {'通过' if passed else '失败'}")
        if not passed:
            all_secure = False

    print("\n" + "="*80)
    if all_secure:
        print("✓ 安全审计通过")
    else:
        print("✗ 存在安全风险，请修复上述问题")
    print("="*80 + "\n")

    return all_secure


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv(dotenv_path='config/.env')
    run_security_audit()