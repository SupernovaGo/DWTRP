"""
玩家身份卡资源库
======================
data/identities/<id>.json 存放一张张身份卡（模板）。
新建会话时可挑选一张复制进会话（会话内编辑仅影响该会话）。
"""
import copy
import json
import os
import re

from settings import CONFIG


def _dir() -> str:
    return os.path.join(CONFIG["DATA_DIR"], "identities")


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


def _summary(card: dict) -> dict:
    return {
        "id": card.get("id"),
        "name": card.get("name") or card.get("id"),
        "role": card.get("role", ""),
        "description": (card.get("description") or "")[:60],
    }


def list_identities() -> list:
    if not os.path.isdir(_dir()):
        return []
    out = []
    for name in sorted(os.listdir(_dir())):
        if not name.lower().endswith(".json"):
            continue
        card = _read(name[:-5])
        if card:
            out.append(_summary(card))
    return out


def get(cid: str) -> dict | None:
    return _read(cid)


def upsert(card: dict) -> dict:
    os.makedirs(_dir(), exist_ok=True)
    card = copy.deepcopy(card)
    cid = str(card.get("id") or slugify(card.get("name", ""))).strip()
    card["id"] = cid
    card.setdefault("name", cid)
    card.setdefault("role", "")
    card.setdefault("description", "")
    with open(_path(cid), "w", encoding="utf-8") as f:
        json.dump(card, f, ensure_ascii=False, indent=2)
    return get(cid)


def delete(cid: str) -> bool:
    p = _path(cid)
    if os.path.exists(p):
        os.remove(p)
        return True
    return False
