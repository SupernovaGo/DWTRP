"""
角色资源库
================
data/characters/<id>.json 存放一张张角色卡（模板）。
支持按名称/id 搜索、按 tag 筛选；新建会话时可挑选若干角色复制进会话。
"""
import copy
import json
import os
import re

import card_schema
from settings import CONFIG


def _dir() -> str:
    return os.path.join(CONFIG["DATA_DIR"], "characters")


def _path(cid: str) -> str:
    return os.path.join(_dir(), f"{cid}.json")


def _read(cid: str) -> dict | None:
    p = _path(cid)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    return None


def slugify(name: str) -> str:
    slug = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", (name or "").strip())
    return slug or os.urandom(3).hex()


def _card_summary(card: dict) -> dict:
    return {
        "id": card.get("id"),
        "name": card_schema.display_name(card) or card.get("id"),
        "surname": card.get("surname", "") or "",
        "is_core": card_schema.is_core(card),
        "tags": card.get("tags") or [],
        "intro": (card_schema.get_field(card, "intro", "") or "")[:60],
    }


def all_characters() -> list:
    if not os.path.isdir(_dir()):
        return []
    out = []
    for name in sorted(os.listdir(_dir())):
        if not name.lower().endswith(".json"):
            continue
        card = _read(name[:-5])
        if card:
            out.append(card)
    return out


def list_characters(q: str = "", tags: list | None = None) -> list:
    q = (q or "").strip().lower()
    tags = tags or []
    out = []
    for card in all_characters():
        if q:
            hay = (f"{card_schema.display_name(card)} {card.get('id','')} "
                   f"{card_schema.get_field(card, 'intro', '')}").lower()
            if q not in hay:
                continue
        if tags:
            card_tags = set(card.get("tags") or [])
            if not set(tags).intersection(card_tags):
                continue
        out.append(_card_summary(card))
    return out


def all_tags() -> list:
    seen = []
    for card in all_characters():
        for t in card.get("tags") or []:
            if t and t not in seen:
                seen.append(t)
    return sorted(seen)


def get(cid: str) -> dict | None:
    return _read(cid)


def upsert(card: dict) -> dict:
    os.makedirs(_dir(), exist_ok=True)
    card = copy.deepcopy(card)
    cid = str(card.get("id") or slugify(
        card.get("name", "") or card_schema.display_name(card) or "")).strip()
    card["id"] = cid
    if not (card.get("name") or "").strip():
        card.setdefault("name", cid)
    if "is_core" not in card:
        card.setdefault("is_core", False)
    card.setdefault("tags", [])
    with open(_path(cid), "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    return get(cid)


def delete(cid: str) -> bool:
    p = _path(cid)
    if os.path.exists(p):
        os.remove(p)
        return True
    return False


def resolve(ref: str) -> str | None:
    """把 name/id 解析为资源库角色 id。"""
    if not ref:
        return None
    ref = str(ref).strip()
    if _read(ref):
        return ref
    for card in all_characters():
        if card_schema.display_name(card) == ref:
            return card.get("id")
    for card in all_characters():
        name = card_schema.display_name(card)
        if name and (name in ref or ref in name):
            return card.get("id")
    return None
