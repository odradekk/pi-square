---
"@odradekk/pi-square": minor
---

Rework the display output of the five filesystem tools (`read`, `ls`, `edit`, `write`, `find`) to conform to the single-bullet visual grammar. Each tool now states what it did instead of dumping what it handled: `Read` reports lines and continuation offsets, `List` counts directories and files with directories sorted first, `Edit` shows a bounded diff with new-file line numbers and no `@@` or `(+N,-M)` header, `Write` says `Created` or `Overwrote`, and `Find` reports a file count. All five tools use C6 error sentences, C7 truncated badges, and C8 no-restating sections.
