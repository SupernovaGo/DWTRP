"""
下载嵌入模型到 HuggingFace 缓存
================================
嵌入模型（默认 `BAAI/bge-base-zh-v1.5`，约 400 MB）不属于代码仓库，
首次使用向量检索前需要下载一次。

    python scripts/fetch_embedding_model.py
    python scripts/fetch_embedding_model.py --model BAAI/bge-base-zh-v1.5
    python scripts/fetch_embedding_model.py --endpoint https://hf-mirror.com   # 国内镜像

下载后模型保存在 HuggingFace 缓存目录（`HF_HOME` 或 `~/.cache/huggingface`），
服务端默认以离线方式从缓存加载，避免网络受限时反复重试。
"""
import argparse
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description="下载嵌入模型到本地 HuggingFace 缓存")
    parser.add_argument("--model", default="BAAI/bge-base-zh-v1.5", help="模型名（默认 BAAI/bge-base-zh-v1.5）")
    parser.add_argument("--endpoint", default="", help="HuggingFace 镜像地址，如 https://hf-mirror.com")
    parser.add_argument("--quiet", action="store_true", help="减少输出")
    args = parser.parse_args()

    # 下载必须联网：临时关闭离线开关。
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["TRANSFORMERS_OFFLINE"] = "0"
    if args.endpoint:
        os.environ["HF_ENDPOINT"] = args.endpoint

    def say(msg: str) -> None:
        if not args.quiet:
            print(msg, flush=True)

    say(f"[1/2] 检查依赖…（HF_HOME={os.environ.get('HF_HOME', '(默认 ~/.cache/huggingface)')}）")
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        print("[ERROR] 未安装 sentence-transformers（可选依赖）。\n"
              "        先执行： python -m pip install -r requirements-embedding.txt\n"
              "        或在「设置 → 运行环境」里点击「安装嵌入依赖」。", file=sys.stderr)
        return 2

    say(f"[2/2] 下载并加载模型 {args.model} …")
    try:
        model = SentenceTransformer(args.model)
        vec = model.encode(["连接测试"], normalize_embeddings=True, show_progress_bar=False)
    except Exception as e:  # noqa: BLE001
        print(f"[ERROR] 下载/加载失败：{type(e).__name__}: {e}", file=sys.stderr)
        print("        网络受限时可加 --endpoint https://hf-mirror.com 重试。", file=sys.stderr)
        return 1

    print(f"[OK] 模型已就绪：{args.model}（向量维度 {len(vec[0])}）")
    print("     服务端默认以离线方式从缓存加载；重启服务后向量检索即可生效。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
