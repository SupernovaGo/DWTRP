"""
判断前端是否需要重新构建
========================
比较 `web/src`（及配置/模板文件）与构建产物 `web/dist/index.html` 的修改时间。

退出码：
    0 —— 产物是最新的，无需构建
    1 —— 源码比产物新，需要重新构建
    2 —— 产物不存在
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
DIST_INDEX = os.path.join(WEB, "dist", "index.html")
SOURCES = ["src", "index.html", "package.json", "vite.config.ts", "tsconfig.app.json"]
IGNORE_DIRS = {"node_modules", "dist", ".git"}


def newest_mtime(path: str) -> float:
    if os.path.isfile(path):
        return os.path.getmtime(path)
    newest = 0.0
    for base, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for name in files:
            try:
                newest = max(newest, os.path.getmtime(os.path.join(base, name)))
            except OSError:
                pass
    return newest


def main() -> int:
    if not os.path.exists(DIST_INDEX):
        print("web/dist 不存在")
        return 2
    dist_time = os.path.getmtime(DIST_INDEX)
    newest, where = 0.0, ""
    for rel in SOURCES:
        path = os.path.join(WEB, rel)
        if not os.path.exists(path):
            continue
        t = newest_mtime(path)
        if t > newest:
            newest, where = t, rel
    if newest > dist_time:
        print(f"web/{where} 比 web/dist 新，需要重新构建")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
