"""
数据目录初始化
====================
本项目只加载“标准格式”的数据文件（见 card_schema.py 的英文键规范）。
方便用户直接把标准格式文件放入 data/characters、data/worldbooks 目录，
刷新前端即可看到。
"""
from settings import ensure_dirs


def ensure_initialized():
    ensure_dirs()
