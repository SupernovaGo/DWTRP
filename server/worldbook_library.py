"""
世界书资源库
==================
data/worldbooks/<id>.json 存放一本本世界书（模板/示例）。
新建会话时按需复制选中的世界书进会话数据，避免改动原始模板。
"""
import copy
import json
import os

import card_schema
from settings import CONFIG


def _dir() -> str:
    return os.path.join(CONFIG["DATA_DIR"], "worldbooks")


def _path(wid: str) -> str:
    return os.path.join(_dir(), f"{wid}.json")


def _read(wid: str) -> dict | None:
    p = _path(wid)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def list_worldbooks() -> list:
    if not os.path.isdir(_dir()):
        return []
    out = []
    for name in sorted(os.listdir(_dir())):
        if not name.lower().endswith(".json"):
            continue
        wid = name[:-5]
        data = _read(wid)
        if not data:
            continue
        entries = card_schema.world_entries(data)
        locations = card_schema.world_locations(data)
        out.append({
            "id": wid,
            "name": card_schema.wb_name(data) or wid,
            "overview": (card_schema.wb_overview(data) or "")[:80],
            "entries": len(entries),
            "locations": len(locations),
        })
    return out


def get(wid: str) -> dict | None:
    return _read(wid)


def upsert(wid: str, data: dict) -> dict:
    os.makedirs(_dir(), exist_ok=True)
    data = copy.deepcopy(data)
    data["id"] = wid
    with open(_path(wid), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def delete(wid: str) -> bool:
    p = _path(wid)
    if os.path.exists(p):
        os.remove(p)
        return True
    return False


def merge_worldbooks(items: list) -> dict:
    """把多本世界书合并为一本：entries/locations 去重拼接；名字/概览/基调会拼接在一起，
    确保世界摘要里能看到每一本世界书的内容，而不是只显示第一本。"""
    items = [i for i in items if isinstance(i, dict)]
    if not items:
        return {}
    base = copy.deepcopy(items[0])
    # 名字：多本时用 “ + ” 连接（去重），并写入第一个存在的名字字段
    names = list(dict.fromkeys(
        n for n in (card_schema.wb_name(i) for i in items) if n))
    if len(names) > 1:
        if "name" in base or "world" not in base:
            base["name"] = " + ".join(names)
        else:
            base["world"] = " + ".join(names)
    # overview / tone：多本时全部拼接，避免“第二本摘要不显示”
    for key in ("overview", "tone"):
        vals = [str(i.get(key) or "").strip() for i in items if i.get(key)]
        if vals:
            base[key] = "\n\n".join(vals)
    for item in items[1:]:
        # 设定词条（标准 entries 字段）
        if isinstance(base.get("entries"), list) and isinstance(item.get("entries"), list):
            base["entries"] = _dedup_entries(base["entries"], item["entries"])
        elif not base.get("entries") and item.get("entries"):
            base["entries"] = item["entries"]
        # 地点树（标准 locations 字段）
        if isinstance(base.get("locations"), list) and isinstance(item.get("locations"), list):
            base["locations"] = _merge_location_trees(base["locations"], item["locations"])
        elif not base.get("locations") and item.get("locations"):
            base["locations"] = item["locations"]
    return base


def _dedup_entries(a: list, b: list) -> list:
    """按“关键词集合 + 信息”去重合并两批设定词条。"""
    seen = []
    result = []
    for raw in list(a) + list(b):
        if not isinstance(raw, dict):
            continue
        kws = raw.get("keywords") or []
        if isinstance(kws, str):
            kws = [kws]
        info = raw.get("info") or raw.get("description") or ""
        sig = (tuple(str(k).strip() for k in kws), str(info).strip())
        if sig not in seen:
            seen.append(sig)
            result.append(raw)
    return result


def _merge_location_trees(a: list, b: list) -> list:
    """按“一级地点名”合并两棵地点树；同名则在 children 里继续合并。"""
    result = copy.deepcopy(a)
    for node in b:
        if not isinstance(node, dict):
            continue
        name = node.get("name") or ""
        target = None
        for existing in result:
            ename = existing.get("name") or ""
            if ename == name:
                target = existing
                break
        if target is None:
            result.append(node)
        else:
            if not target.get("description") and node.get("description"):
                target["description"] = node.get("description")
            target["children"] = _merge_location_trees(
                target.get("children") or [], node.get("children") or [])
    return result
