# Character card and worldbook standard

**English** | [中文](std_data.zh-CN.md)

## Character card definition

When you create a character card in the UI, all required fields must be filled in or the card cannot be created. Recommended fields are collapsed by default and are optional; the plus button lets you add your own custom fields.

#### Required fields

These must be present, otherwise the file cannot be imported.

- `id` (usually the romanised given name)
- `name`: string
- `intro`: string
- `personality`: string
- `appearance`: string — the character's default look
- `tags`: list of strings, used for filtering
- `is_core`: boolean — core characters should have a more detailed card

#### Recommended fields

Optional, but when present the project parses them and uses them in several features.

- `surname`: string — lets the chat toggle between given name and full name
- `aliases`: list of strings — any alias still resolves to this character
- `avatar`: the character's portrait. Because avatars are small, this field may hold the image's base64 data, which the front end decodes for display
- `speech_style`:
  - `description`: string
  - `examples`: list of strings
- `relationships`: parsed by the UI into a visual relationship graph
  - `target`: the other character this relationship points to
  - `address`: how this character addresses them, e.g. Midori, darling
  - `relation`: a short label shown on the graph, e.g. sister, student
  - `detail`: a paragraph describing how this character relates to `target`
  - `affection`: a decimal between 0 and 1

#### Custom fields

Custom fields are not parsed, but they are sent to the model as information. You may use any field names; the whole block is passed to the model as-is.

- For example an affiliation, typical behaviour, and so on



## Worldbook definition

#### Required fields

- `name`: string
- `overview`: string — a short description of the setting. This text is permanently inserted into every agent's prompt

#### Recommended fields

`entries` is the main content of a worldbook: most information lives there, roughly equivalent to SillyTavern's Entry field. When a keyword is mentioned in the conversation, the matching entry is inserted into the prompt.

- `entries`:
  - `keywords`: list of strings (several spellings/translations of the same information may be listed), used to trigger the entry
  - `importance`: a value from 0 to 100 — world rules or important history rate high, trivia or minor history rate low
  - `info`: string, a detailed description of this entry
- `locations` (the environment panel takes location names from the worldbook; sub-locations may be supplied by the AI — e.g. if the AI picked "XX City > XX Street" from the worldbook, it may optionally add "XX's home" based on the context; up to three levels are supported):
  - first-level location name: string
    - `description`: string
    - `children`:
      - second-level location name
        - `description`
        - third-level location name
          - `description`
