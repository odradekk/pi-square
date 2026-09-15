---
"@odradekk/pi-square": patch
---

Shadow Minds: sync the published reference assets with the validator split (#365) and derive the model-reference pattern from the whole-reference cap. The guide describes the schema reference contract block as generated from the bounds entries the parser and validators enforce, and the schema reference publishes the cap-derived pattern.

Deriving the pattern narrows its second segment from 199 to 197 characters. A `model` value whose segment after the separator is 199 or 200 characters long is therefore rejected where it was previously accepted, because the `model` field is validated by the pattern alone. `parentModels` entries are unaffected: they are checked against the 200-character cap as well as the pattern, so the cap already rejected those lengths.
