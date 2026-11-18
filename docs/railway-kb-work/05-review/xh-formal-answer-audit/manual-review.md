# DOC0026/27 Formal Answer Audit

Checked: 2026-11-17 20:02 Asia/Shanghai

Evidence: `inputs.json`, `manifest.json`, `answers.json`, and `report.json`; audit app `cd61c7fa244c4fdfb5ffa95e8174fd3e`. Ten answers were generated in about 13 minutes using a separate search app and the formal XH dataset. The original user app configuration hash remained unchanged. All cited chunk IDs resolve to chunks accepted by current formal chunk-quality evidence. This is a local diagnostic, not the 70-question regression, independent holdout, or final citation audit.

| Test IDs | Decision | Finding |
| --- | --- | --- |
| XH26-D01, XH26-D02, XH27-D01, XH27-D02, XH27-D03, XH27-D04 | Core answer pass | Required conditions, materials, exceptions, deadlines, and distinctions are supported by the retrieved formal chunks. |
| XH26-D03, XH27-D05 | Boundary pass | Both identify the source table cells as blank and decline to supply a value. |
| XH26-N01, XH27-N01 | Partial; no-evidence acceptance fails | Both decline the requested unsupported confirmation, but add advice to consult maintenance/calibration rules or certificates/issuer announcements without those sources in the library. Remove unsupported recommendations or explicitly constrain the response to the missing evidence. |

The structured report's `all_references_are_accepted_formal_chunks=true` confirms chunk identity and provenance only; it does not establish every cited chunk's relevance to every claim. DOC0026/27 remain ineligible for final document count pending answer/citation closure and final regression.
