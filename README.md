# TRPE · Dynamic-World Text Role-Playing Engine

[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#quick-start)
[![Python](https://img.shields.io/badge/python-3.11%2B-blue)](#requirements)
[![LLM](https://img.shields.io/badge/LLM-DeepSeek%20API-4d6bfe)](#configure-the-api-key)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![version](https://img.shields.io/badge/version-1.0-orange)](#version-history)

**English** | [中文](README.zh-CN.md)

**Text Role-Playing Engine (TRPE)** — a player-centric, multi-agent collaborative dynamic-world text role-playing engine.

Instead of the usual "one question, one answer" chatbot, several specialised agents maintain a world that keeps running: characters have their own memories and plans, the environment changes with time and with what the player does, and the wider world advances in the background.

## Main UI

![main UI](./docs/mainUI.png)

---

## Table of contents

- [Core features](#core-features)
- [Quick start](#quick-start)
- [Optional: vector search and the embedding model](#optional-vector-search-and-the-embedding-model)
- [Language](#language)
- [Configure the API key](#configure-the-api-key)
- [UI overview](#ui-overview)
- [Character memory and planning](#character-memory-and-planning)
- [Character cards and worldbooks](#character-cards-and-worldbooks)
- [Directory layout](#directory-layout)
- [Phone / tablet access](#phone--tablet-access)
- [Logs and troubleshooting](#logs-and-troubleshooting)
- [Tech stack](#tech-stack)
- [Known issues](#known-issues)
- [Version history](#version-history)

---

## Core features

Unlike single-character chat tools such as SillyTavern, this project focuses on **simulating a world with many characters**.

#### Multi-agent world simulation

| Agent | Responsibility | When it runs |
| --- | --- | --- |
| **Player Agent** | Decides, from the situation and each character's plan, which characters react this turn, and sketches the direction of the story | Every turn |
| **Environment Agent** | Maintains the environment around the player (time / weather / location / details) from the Player Agent and the acting characters' output, keeping the world consistent | Every turn |
| **Frontend Agent** | Plays a character on stage; with several characters they run in sequence, so earlier actions and lines enter the later characters' context | 0 – N times / turn |
| **Character Memory Agent** | Turns what a character lived through into long-term memory, and notes personality / relationship changes | When world time reaches an update point, or manually |
| **Character Plan Agent** | Plans what each character will do in the next period, based on the new memories | Same as above |
| **World Update Agent** | Advances the macro world — social and natural changes from the last update to now — using the hints, character updates and timeline | Same as above |

Several helper tasks exist as well: session initialization, AI writing / rewriting, story mode, recent-memory summarization, and more.

World/character updates use a **two-phase** design: results are generated on a background thread (during which the front end stays usable), and only then is data briefly locked and written back — so long background updates never block your typing.

#### Multi-character support

A scene natively supports several interacting characters, scheduled by the Player Agent. A range of filters compresses the Player Agent's context (only characters who *could* interact with the player this turn are listed), keeping token usage acceptable.

#### Visualised information

- **Precise mode**: characters are required to output thought / action / speech separately (AI writing follows the same rule) and they are rendered in different styles for readability. Player messages can also switch between normal and precise mode, with customizable rendering styles.
- **Environment panel** (left column on desktop, top on mobile): shows the player's current time, weather, location and environment details, updated each turn, with a `NEW!` badge on what changed — which keeps the world consistent and helps the player decide what to do next.

#### A world that is easy to control

- **World directives**: insert any number of directives at any time to steer the plot or the world.
- **The "directive" segment in the input box**: converted into a one-shot world directive that only applies to this turn (change location, advance time, call on a character…).
- Weather, time, world background and world summary can be edited at any time.
- Want to know what a character is thinking? Turn on "show thoughts". Too lazy to type? Use AI write. Want to read it as a novel? Turn on **story mode** and optionally describe how the story should develop (in story mode only the Environment Agent is called each turn).

#### Optimised for world simulation

- Every agent prompt is **prefix-stabilised**: long-lived content goes first, improving KV-cache hits.
- Characters are split into "core" and "regular"; you can configure "generate long-term memory and plans for core characters only", "player character detail level", and so on, greatly reducing token usage.
- Characters can be added to / removed from the world at any time, so new characters can enter and old ones can leave the story.
- Parallelised wherever possible: memory summaries, world updates and character updates all run in the background and only lock briefly when writing.

---

## Quick start

#### Requirements

To run this project you need:

1. Python installed (**≥ 3.11**) and available on your `PATH`.
2. A **DeepSeek API Key**.

| Component | Version | Required | Notes |
| --- | --- | --- | --- |
| **Python** | **≥ 3.11** | ✅ Yes | Backend and engine (uses the `tomllib` standard library) |
| **DeepSeek API Key** | — | ✅ Yes | Only the DeepSeek API is supported, for every LLM call |
| **Node.js** | ≥ 20.19 | ⬜ No | Only needed to modify / rebuild the front end; a built `web/dist` ships with the repo |
| **torch + sentence-transformers** | — | ⬜ No | Vector search (semantic memory); without them BM25 keyword search is used |
| **Embedding model** `BAAI/bge-base-zh-v1.5` | ~400 MB | ⬜ No | Downloaded once before the first vector search; **not** shipped with the repo |

Disk usage: about 200 MB with required dependencies only; 1 – 3 GB more with torch, depending on platform; about 400 MB for the embedding model.

#### First run

1. **Prepare the environment**: on Windows double-click `setup.bat` (on macOS / Linux run `./setup.sh`). It creates `.venv`, installs the required dependencies and asks whether to install the optional vector-search components.
2. **Enter the API key**: after starting, go to "Settings → Connection / Advanced" and paste your DeepSeek API Key.
3. **Create a session**: in "Main / Library" create a session — pick a worldbook, characters and a player identity, write the opening prompt, check the initialization preview, and start.

> There is **no default session** on first launch; create one yourself. (The bundled *Blue Archive* worldbook and character cards are only demos.)

#### Windows: one-step setup + start

```bat
setup.bat     :: create .venv, install required deps, ask about vector search
start.bat     :: start the backend and open the browser (builds the front end if needed)
```

`start.bat` looks for an interpreter in this order: the `TRPE_PYTHON` environment variable → the project's `.venv` → `py -3` → `python` on `PATH`. In other words: **if you already have a Python ≥ 3.11 environment, just point `TRPE_PYTHON` at it** — no virtualenv needed:

```bat
set TRPE_PYTHON=D:\Python\.venv\Scripts\python.exe
start.bat
```

#### macOS / Linux

```bash
./setup.sh    # same as python3 scripts/setup_env.py
./start.sh
```

#### Manual

```bash
python -m pip install -r requirements.txt
python server/main.py            # default http://127.0.0.1:8000
python server/main.py --host 0.0.0.0 --port 8000   # allow LAN / phone access
python server/main.py --mock     # offline mode: no LLM calls, for checking the UI and API
```

The built front end ships with the repo (`web/dist`, served directly by the backend), so **normal use does not need Node.js**. Only do this when you change the front end:

```bash
cd web
npm install
npm run build        # output goes to web/dist
npm run dev          # hot-reload dev server (proxies /api to http://127.0.0.1:8000)
```

#### Setup script

`scripts/setup_env.py` is the cross-platform setup script; `setup.bat` / `setup.sh` are thin wrappers around it:

```bash
python scripts/setup_env.py --check                 # only check the environment
python scripts/setup_env.py                         # create .venv + install required deps (asks about optional ones)
python scripts/setup_env.py --yes                   # non-interactive: required deps only
python scripts/setup_env.py --embedding --download-model    # include vector search
python scripts/setup_env.py --pip-index https://pypi.tuna.tsinghua.edu.cn/simple
```

---

## Optional: vector search and the embedding model

**The only required dependency file is `requirements.txt`** (FastAPI + BM25 keyword retrieval). The vector-search dependencies — `torch` and `sentence-transformers` — together with the embedding model are very large, so **they are not distributed with the project**; the setup script asks whether you want them:

```
Vector search (semantic memory) needs extra torch + sentence-transformers (hundreds of MB to several GB)
and an embedding model (about 400 MB). Everything works without them, using BM25 keyword matching;
you can install them later in "Settings → Runtime".
Install the vector-search dependencies and model now? [y/N]
```

**If you skip it:** long-term memory is still written, retrieved and forgotten as usual; relevance is then scored with BM25 keywords only (+ importance + recency), without semantic similarity. The UI shows "BM25 keywords only".

**To add it later (any of three ways):**

1. **Settings → Runtime**: see "Python version / dependencies installed? / model cached?", and install the embedding dependencies or download the model with one click, with live progress and logs. You can also toggle vector search and set the pip index and HuggingFace endpoint there.
2. **Re-run the setup script**: `python scripts/setup_env.py --embedding --download-model`
3. **Manual commands**:

   ```bash
   python -m pip install -r requirements-embedding.txt      # optional dependencies
   python scripts/fetch_embedding_model.py                  # download the embedding model
   python scripts/fetch_embedding_model.py --endpoint https://hf-mirror.com   # mirror
   ```

> **In mainland China**: use the mirror `https://hf-mirror.com` to download the model (set it in "Settings → Runtime", or pass `--endpoint`).
>
> **CUDA acceleration (optional)**: `python -m pip install --index-url https://download.pytorch.org/whl/cu129 torch`, then `pip install -r requirements-embedding.txt`. Running on CPU only works fine too.

The model files are stored in the HuggingFace cache (`HF_HOME` or `~/.cache/huggingface`). The server loads cached models **offline** by default, so a restricted network will not make it retry forever and appear stuck on "responding"; the matching setting is `[embedding] offline` in `config.toml`.

Related settings (also editable in the UI):

```toml
[embedding]
enabled = true        # off: BM25 only, even with torch installed
offline = true        # load from the local cache only, never online
model_name = "BAAI/bge-base-zh-v1.5"	# default embedding model
dim = 768

[env]
pip_args = []         # extra pip arguments when installing optional deps
pip_index_url = ""    # e.g. https://pypi.tuna.tsinghua.edu.cn/simple
hf_endpoint = ""      # e.g. https://hf-mirror.com
```

---

## Language

The UI ships with **full English and Chinese support**, switchable at runtime in **Settings → Personalization → 🌐 Language / 语言**. The choice is stored in the browser and takes effect immediately. Attention: **The default prompt language is Chinese**.

---

## Configure the API key

On first use, paste your DeepSeek API Key in **Settings → Connection / Advanced** (it is stored in `server/.env`), or edit that file directly (copy it from `server/.env.example`):

```ini
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
```

> Without a key the backend still starts and the UI can be browsed, but chatting, updates and memory summaries will report "API Key not found".
>
> When no key is configured the UI says so clearly: an amber banner appears at the top, "Settings" and "Settings → Connection / Advanced" get an exclamation mark, and a hint above the input box says "no API Key configured, cannot send" — click it to jump to the field.
>
> Only the **DeepSeek API** is supported

---

## UI overview

The top bar is the navigation; the main view is one of the sections:

- **Main**: input bar at the bottom + three columns (environment on the left / history in the middle / world panel on the right); the side columns are drag-resizable.
  - Left (what the player perceives): current time, weather (icon follows the weather), location, environment notes, with a `NEW!` badge on changes.
  - Middle (Story): the exchange and actions, streamed. Actions are rendered in *italics*, speech in 「」 bubbles, character thoughts hidden by default.
  - Right (world panel): **Memory** (capacity bar, event stats, importance trend, add/remove events), **characters**, **player identity**, **world info** (view/edit each worldbook, world summary, timeline) and **session config**.
- **Library**: manage the three template libraries — worldbooks, character cards (with search and tags) and player identities — and download template files.
- **Settings**: engine parameters, prompts, runtime environment, personalization (including the language switch), connection / advanced (API key and raw JSON config).
- **Logs**: the full prompt and raw model output for every agent, plus key runtime events (filterable by agent / event type, with search).
- On the left (a dropdown at the top on mobile) is the **session bar**: create, switch and delete sessions.

---

## Character memory and planning

#### How memory is produced and retrieved

- **Recent events (working memory)**: accumulated in the session as "time / place / weather / environment changes" during the conversation; once `working_memory_limit` is exceeded, the earlier part is summarized by the LLM into individual **events**.
- **Long-term memory (events)**: events are the only unit of long-term memory (a memorable summary + importance + time).
- **Vectors stored in local files**: each character's memory vectors live in `server/data/sessions/<id>/memory/<character id>.vec.pkl`; retrieval reads the file and computes cosine similarity, with no database.
- **Scoring**: `relevance (vector similarity + BM25 keywords) + importance + recency`, top events are selected into the character context. Without the embedding model, relevance degrades to BM25 only.
- **Multi-round retrieval (optional)**: with `[memory] agentic_retrieval = true`, a character can plan its retrieval before answering — rewriting the query, inspecting events by id, for up to `max_retrieval_rounds` rounds.
- By default long-term memory and planning are generated for **core characters only**; change that in "Settings → Engine" or the session config.

#### Forgetting

Long-term memories are scored by recency and importance; once `max_events` is exceeded, the lowest-scoring memories are dropped.

#### Character planning

The `Character Plan Agent` uses the freshly summarized memories to plan what a character will do **next period**. Each entry has `time / place / action / related to the player`, and there can be several that connect end to end; plans enter the Player Agent's and Frontend Agent's context so characters act coherently over time.

---

## Character cards and worldbooks

Character cards and worldbooks are stored as JSON. To support its distinctive features, this project's cards and worldbooks are **not compatible** with SillyTavern; the field specification is in `docs/std_data.md`, and the **Library** UI can download template files:

- `templates/character_card.template.json`
- `templates/worldbook.template.json`

Fields come in three groups:

| Group | Description |
| --- | --- |
| **Required** | e.g. a card's `name` / `intro`, a worldbook's `name` / `overview`; missing fields fail the import |
| **Recommended** | e.g. a card's `surname` / `relationships` / `speech_style`, a worldbook's `locations` / `entries`; usable when missing |
| **Custom** | character cards only; custom fields are not parsed but are **concatenated verbatim** into the Frontend Agent's context |

When a session is created, the selected worldbook, character cards and identity are **copied** into the session directory; later edits affect that session only, so several sessions can share one set of templates while evolving separately.

---

## Directory layout

```text
TRPE/
├── README.md                     # this document (English)
├── README.zh-CN.md               # Chinese version
├── docs/
│   ├── architecture.png          # system architecture diagram
│   ├── architecture.svg          # diagram source (edit and re-export)
│   └── std_data.md               # data field specification
├── requirements.txt              # required deps (backend + BM25)
├── requirements-embedding.txt    # optional deps (torch + sentence-transformers)
├── setup.bat / start.bat         # Windows one-step setup / start
├── setup.sh  / start.sh          # macOS / Linux
├── scripts/
│   ├── setup_env.py              # environment setup (venv, deps, optional vector search)
│   ├── fetch_embedding_model.py  # download the embedding model (mirror aware)
│   └── check_frontend.py         # decide whether the front end needs rebuilding
├── server/                       # Python backend (engine + FastAPI API)
│   ├── main.py                   # backend entry point: python server/main.py
│   ├── config.toml               # config (world / memory / agents / embedding / server)
│   ├── i18n.py                   # server-side message localization
│   ├── settings.py               # config loading (including server/.env)
│   ├── embedding.py              # embedding model (optional; falls back to BM25)
│   ├── env_manager.py            # runtime detection / install / model download
│   ├── memory.py                 # long-term memory: events + vectors + BM25 + forgetting
│   ├── agents/core.py            # agent prompts and parsing
│   ├── world_session.py          # the world loop of one session (state / timeline / updates)
│   ├── sessions.py               # session management (index, resource copies, savepoints)
│   └── data/                     # data directory (library + per-session runtime data)
│       ├── characters/           # character card library
│       ├── worldbooks/           # worldbook library
│       ├── identities/           # player identity library
│       ├── sessions/<id>/        # session copies and runtime state (memory / state / timeline)
│       └── logs/                 # LLM call logs and runtime event logs
└── web/                          # React front end (Vite + Tailwind + shadcn/ui)
    ├── src/                      # components, state, API client, i18n
    └── dist/                     # build output (ships with the repo, served by the backend)
```

All data lives in `server/data/`: the library (worldbooks / character cards / identities) holds global templates, `sessions/<id>/` holds each session's copy and runtime data, and `logs/` holds the call logs.

---

## Phone / tablet access

The backend listens on `0.0.0.0` by default. Put your phone and PC on the same Wi-Fi and open
`http://<PC LAN IP>:8000` in the browser (the IP is shown and copyable in "Settings → Personalization → 📱 Mobile access").

The mobile UI is partly adapted: the world panel is hidden in a bottom drawer by default, the environment panel takes the upper half and the conversation the lower half (with a draggable divider), and the top navigation scrolls horizontally. On **mobile** the "📱 Mobile access" card also offers a "shut down the PC" button
(30-second countdown, cancellable; Windows only).

> The embedding model needs torch, which is awkward to run on a phone, so mobile works as "PC as server + phone browser".

---

## Logs and troubleshooting

Every LLM call records the **full prompt (system + user) and the raw model output / parsed result**:

```text
server/data/logs/llm_YYYY-MM-DD.jsonl      # every LLM call
server/data/logs/events_YYYY-MM-DD.jsonl   # key runtime events (non-LLM)
```

The logs view can filter by agent / event type (`player`, `world_update`, `memory_summary`, `turn_done`, …) and search the content; prompts and raw output are collapsed by default.

If "the environment changes but no character reacts", check in order:

1. Whether the `invoke` list from the Player Agent really contains characters — if not, the model decided nobody needs to reply this turn;
2. Whether there is an `unknown_character` (the model used a Chinese name while the card stores an id — this project resolves both ways);
3. Whether there is a `frontend_failed` or `memory_context_failed` (e.g. a missing embedding model, which then degrades to "no related memory" instead of blocking the chat);
4. Whether the `raw` field of that agent in `llm_*.jsonl` is valid JSON containing `sequence`.

Logs are kept for the last few days by default (`[logs] retention_days` in `config.toml`).

---

## Tech stack

![architecture](./docs/architecture.png)

| Layer | Technology |
| --- | --- |
| Frontend | React 19 · Vite · TypeScript · Tailwind CSS · shadcn/ui (base-ui) · zustand · recharts |
| Backend | Python 3.11+ · FastAPI · uvicorn · SSE streaming |
| Memory | rank-bm25 · jieba · numpy (vector search needs the optional sentence-transformers) |
| Model | DeepSeek Chat (OpenAI compatible) · optional local embedding `BAAI/bge-base-zh-v1.5` |
| Storage | JSON files (library / session copies / state / timeline / logs) + local vector files |

---

## Known issues

- Because the Player Agent schedules character behaviour (with low reasoning effort by default), replies are slightly slower to start, especially when the KV cache is cold.
- Spatio-temporal consistency is not fully guaranteed and the relationship graph is incomplete (characters may "not know" each other or get each other's backgrounds wrong).
- Chrome dark mode affects the visibility of some UI parts; the mobile UI may still have rough edges.
- Editing messages after "rewrite / rewind" may misbehave. World state and the environment follow time, so after rewinding several turns the world information is not rewound either — avoid rewinding many turns.
- World simulation is inherently a low-precision approximation: doing it exactly would require full-time planning and simulation of every character, as in *Generative Agents: Interactive Simulacra of Human Behavior*, which is nearly impossible to run in real time and costs far too many tokens. This project trades precision for usability (core vs regular characters, no real-time simulation of everyone, selective memory and planning, plans that are not immediately refreshed when interrupted).
- Some data changes only show up on the next turn.
- Using story mode repeatedly prevents the environment and characters from updating, hurting world consistency.
- The same character's daily plan can be very similar from day to day.

---

## Version history

1. A basic novel RAG
2. Tree-structured memory: long-range information dependencies
3. Role-play, memory construction and forgetting
4. Building "the world": multi-agent collaboration
5. UI: from command line to GUI
6. Runtime optimisation: prefix stabilisation, leaner prompts, updates in parallel
7. Feature work and bug fixes
8. Full English support with a language switch, plus bilingual docs

---

## Notes

- Open source under the [MIT License](LICENSE).
- The bulk of the code was written by DeepSeek-V4-Flash and DeepSeek-V4-Flash-Vision-Exp.
- The repo bundles a *Blue Archive* worldbook and the main character cards (compiled from public sources) **for demonstration only**; all rights belong to their original owners.
