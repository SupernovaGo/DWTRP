"""
环境准备（一键安装依赖）
===========================
TRPE 的必需依赖很轻（FastAPI + BM25 检索，见 requirements.txt）；
向量检索所需的 torch / sentence-transformers 与嵌入模型是**可选组件**，
本脚本会先装必需依赖，再询问是否安装可选组件。

常用用法：
    python scripts/setup_env.py                     # 交互式：建虚拟环境 + 装必需依赖 + 询问可选组件
    python scripts/setup_env.py --check             # 只检查当前环境，不做任何改动
    python scripts/setup_env.py --yes               # 非交互：只装必需依赖（跳过可选组件）
    python scripts/setup_env.py --embedding --download-model   # 连可选组件一起装好
    python scripts/setup_env.py --venv D:\\envs\\TRPE          # 指定虚拟环境目录
    python scripts/setup_env.py --pip-index https://pypi.tuna.tsinghua.edu.cn/simple

Windows 用户通常直接双击 `setup.bat`；macOS / Linux 用 `./setup.sh`。
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_MODULES = ["fastapi", "uvicorn", "numpy", "jieba", "rank_bm25", "requests", "tomli_w", "dotenv"]
OPTIONAL_MODULES = ["torch", "sentence_transformers"]
DEFAULT_VENV = os.path.join(ROOT, ".venv")
MIN_PYTHON = (3, 11)


# ---------- 小工具 ----------
def say(msg: str = "") -> None:
    print(msg, flush=True)


def ask(question: str, default: bool = False) -> bool:
    """交互提问；非交互（管道/无输入）时返回默认值。"""
    hint = "Y/n" if default else "y/N"
    try:
        answer = input(f"{question} [{hint}] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        say()
        return default
    if not answer:
        return default
    return answer in ("y", "yes", "是", "1", "true")


def run(cmd: list, env: dict = None, cwd: str = ROOT) -> int:
    say("$ " + " ".join(str(c) for c in cmd))
    merged = dict(os.environ)
    merged["PYTHONUNBUFFERED"] = "1"
    merged["PYTHONIOENCODING"] = "utf-8"
    if env:
        merged.update(env)
    try:
        return subprocess.call(cmd, cwd=cwd, env=merged)
    except FileNotFoundError as e:
        say(f"[ERROR] 无法执行：{e}")
        return 127


def venv_python(venv_dir: str) -> str:
    if os.name == "nt":
        return os.path.join(venv_dir, "Scripts", "python.exe")
    return os.path.join(venv_dir, "bin", "python")


def has_modules(py: str, modules: list) -> bool:
    """在指定解释器里检查模块是否可导入。"""
    code = (
        "import importlib.util as u,sys;"
        f"missing=[m for m in {modules!r} if u.find_spec(m) is None];"
        "print(','.join(missing))"
    )
    try:
        out = subprocess.run([py, "-c", code], capture_output=True, text=True, timeout=300)
    except Exception:  # noqa: BLE001
        return False
    return out.returncode == 0 and not out.stdout.strip()


def python_version(py: str):
    try:
        out = subprocess.run(
            [py, "-c", "import sys;print('%d.%d.%d' % sys.version_info[:3])"],
            capture_output=True, text=True, timeout=60)
        if out.returncode == 0:
            return tuple(int(x) for x in out.stdout.strip().split("."))
    except Exception:  # noqa: BLE001
        pass
    return None


# ---------- 步骤 ----------
def ensure_venv(args) -> str:
    """返回要使用的 Python 解释器路径。"""
    if args.no_venv:
        say(f"[1/4] 使用当前解释器：{sys.executable}")
        return sys.executable

    target = venv_python(args.venv)
    if os.path.exists(target):
        say(f"[1/4] 复用虚拟环境：{args.venv}")
        return target

    ver = sys.version_info
    if ver < MIN_PYTHON + (0,):
        say(f"[ERROR] 需要 Python >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}，当前为 {ver.major}.{ver.minor}.{ver.micro}")
        say("        请安装较新的 Python 后重试： https://www.python.org/downloads/")
        raise SystemExit(1)

    say(f"[1/4] 创建虚拟环境：{args.venv}")
    if run([sys.executable, "-m", "venv", args.venv]) != 0:
        say("[ERROR] 创建虚拟环境失败。若提示缺少 ensurepip，请安装完整版 Python。")
        raise SystemExit(1)
    return target


def install_base(py: str, index_url: str) -> None:
    say("[2/4] 安装必需依赖（requirements.txt）")
    pip = [py, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check"]
    if index_url:
        pip += ["-i", index_url]
    run(pip + ["pip"])  # 升级 pip（失败不致命）
    code = run(pip + ["-r", os.path.join(ROOT, "requirements.txt")])
    if code != 0:
        say("[ERROR] 必需依赖安装失败。国内网络可加 --pip-index https://pypi.tuna.tsinghua.edu.cn/simple")
        raise SystemExit(code)


def install_optional_deps(py: str, index_url: str) -> bool:
    say("[3/4] 安装可选依赖（torch + sentence-transformers，用于向量检索）")
    pip = [py, "-m", "pip", "install", "--upgrade", "--disable-pip-version-check"]
    if index_url:
        pip += ["-i", index_url]
    code = run(pip + ["-r", os.path.join(ROOT, "requirements-embedding.txt")])
    if code != 0:
        say("[WARN] 可选依赖安装失败；不影响运行，记忆检索会使用 BM25 关键词匹配。")
        return False
    return True


def download_model(py: str, endpoint: str) -> None:
    say("[4/4] 下载嵌入模型（约 400 MB，写入 HuggingFace 缓存）")
    cmd = [py, os.path.join(ROOT, "scripts", "fetch_embedding_model.py")]
    if endpoint:
        cmd += ["--endpoint", endpoint]
    env = {"HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0"}
    if endpoint:
        env["HF_ENDPOINT"] = endpoint
    if run(cmd, env=env) != 0:
        say("[WARN] 模型下载失败；可在「设置 → 运行环境」里重试。")


def check(py: str) -> None:
    ver = python_version(py)
    say(f"解释器：{py}")
    say(f"Python 版本：{'.'.join(map(str, ver)) if ver else '未知'}")
    ok = bool(ver and ver >= MIN_PYTHON)
    say(f"版本要求（>= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}）：{'满足' if ok else '不满足'}")
    say(f"必需依赖：{'已就绪' if has_modules(py, BASE_MODULES) else '缺失'}")
    say(f"可选依赖（向量检索）：{'已安装' if has_modules(py, OPTIONAL_MODULES) else '未安装（将使用 BM25）'}")
    try:
        from_env = os.environ.get("HF_HOME", "(默认 ~/.cache/huggingface)")
        say(f"HuggingFace 缓存：{from_env}")
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="TRPE 环境准备")
    parser.add_argument("--venv", default=DEFAULT_VENV, help=f"虚拟环境目录（默认 {DEFAULT_VENV}）")
    parser.add_argument("--no-venv", action="store_true", help="不创建虚拟环境，直接用当前解释器")
    parser.add_argument("--embedding", action="store_true", help="安装可选依赖 torch + sentence-transformers")
    parser.add_argument("--download-model", action="store_true", help="下载嵌入模型")
    parser.add_argument("--mirror", action="store_true", help="下载模型时使用 hf-mirror.com 镜像")
    parser.add_argument("--pip-index", default="", help="pip 源（例如 https://pypi.tuna.tsinghua.edu.cn/simple）")
    parser.add_argument("--yes", "-y", action="store_true", help="非交互模式：只装必需依赖，除非显式指定 --embedding/--download-model")
    parser.add_argument("--check", action="store_true", help="只检查环境，不做改动")
    args = parser.parse_args()

    say("=" * 62)
    say(" TRPE 环境准备")
    say("=" * 62)

    py = sys.executable if args.no_venv else venv_python(args.venv)
    if args.check:
        check(sys.executable if not os.path.exists(py) else py)
        return 0

    py = ensure_venv(args)
    install_base(py, args.pip_index)

    endpoint = "https://hf-mirror.com" if args.mirror else ""
    want_optional = args.embedding
    want_model = args.download_model
    if not args.yes and not (args.embedding or args.download_model):
        say()
        say("向量检索（语义记忆）需要额外的 torch + sentence-transformers（数百 MB ~ 数 GB）")
        say("与嵌入模型（约 400 MB）。不安装也能正常使用，记忆检索会用 BM25 关键词匹配；")
        say("之后随时可以在「设置 → 运行环境」里补装。")
        want_optional = ask("是否现在安装向量检索的依赖与模型？", default=False)
        want_model = want_optional

    if want_optional:
        if install_optional_deps(py, args.pip_index):
            if want_model:
                if not endpoint and not args.yes:
                    say()
                    say("提示：国内网络下载 HuggingFace 模型通常需要镜像。")
                    if ask("使用镜像 https://hf-mirror.com 下载模型？", default=True):
                        endpoint = "https://hf-mirror.com"
                download_model(py, endpoint)

    say()
    say("=" * 62)
    say(" 完成！启动方式：")
    if os.name == "nt":
        say("   · 双击 start.bat（或运行 start.bat）")
    say(f"   · {py} {os.path.join('server', 'main.py')}")
    say(" 然后浏览器打开 http://127.0.0.1:8000")
    say(" 首次使用需在「设置 → 连接 / 高级」里填写 DeepSeek API Key。")
    say("=" * 62)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\n已取消。")
        sys.exit(130)
