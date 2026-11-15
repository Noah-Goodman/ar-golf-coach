# Test fixtures

`synthetic-session.jsonl` is synthetic. It was built byte by byte from the documented R10 layout (measurement, status, control point and battery characteristics), not recorded from a device. Each line uses the live packet log format: `{"t": <unix ms>, "char": "measurement"|"control"|"status"|"battery", "hex": "<lowercase hex>"}`.

It covers: battery reads, wake responses (`80 00 00`), ready/busy statuses, a full shot in one notification (id 1), a shot split across three notifications (id 2), a repeat of shot id 2, a ball-only shot with no club fields (id 3), a standby warning followed by a wake response, an error status with a UTF-8 message, and a shot split across two notifications (id 4).

Split shots follow the rule that bit 0 of the first byte of each notification means more data follows. The first notification's first byte is the low byte of the flags word, so its `MORE_DATA` bit is set and stays set in the decoded `flags`. A continuation notification's first byte is ordinary field data, so the split points were chosen where that byte is odd when another notification follows and even on the last one.

Real logs from the right- and left-handed push/pull sign test belong beside this file, named so the hand and shot shape are clear (for example `signtest-right-push.jsonl`).
