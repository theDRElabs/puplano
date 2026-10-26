# Archive footage fixes

- [x] Fix schema exports, repository-relative paths, and strict CLI arguments.
- [x] Validate license hosts/versions; retain rights evidence and separate review from classification.
- [x] Reject restricted, dark, unavailable, and private media.
- [x] Serialize requests, share rate scheduling across processes, cache responses, and retry entire transfers with timeouts.
- [x] Introduce validated original/derived asset records, exact remote filenames, checksums, and trim lineage.
- [x] Build scene-specific visual briefs and relevance-ranked, paginated discovery.
- [x] Generate timestamped shot contact sheets and local review pages; require visual selection before patching.
- [x] Require rights and contextual-use review; validate selected durations and export attribution.
- [x] Migrate the stale demo manifest without deleting original assets.
- [x] Replace opening credits with multiple relevant illustrative shots; retain graphic scenes where appropriate.
- [x] Add offline regression/integration tests and render-time provenance checks.
- [x] Run all checks and inspect a corrected render, preserving the old final.

Selection policy: metadata ranking is discovery, not visual understanding. Never
silently attach the first search result or the beginning of a movie. Review actual
frames, record a scene-specific reason and time range, and label stock footage as
illustration rather than authentic evidence. License URLs are claims, not legal
verification; no blanket rights clearance is implied.
