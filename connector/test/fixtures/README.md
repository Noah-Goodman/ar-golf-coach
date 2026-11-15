# Test fixtures

Each line of a fixture uses the live packet log format: `{"t": <unix ms>, "char": "measurement"|"control"|"status"|"battery", "hex": "<lowercase hex>"}`.

## recorded-session.jsonl

Recorded from a real R10 on 2026-11-15. It contains wake/standby cycles, two club-only measurements (club speed and shot type, no ball read) and three full shots. Each full shot arrives as two notifications that share a shot id: the first has flags `0x00ff` (more data, ball speed, launch angle, launch direction, backspin, sidespin, club speed, face angle) and the second has flags `0x0f00` (path angle, attack angle, spin type, shot type).

## synthetic-session.jsonl

Synthetic. It was built byte by byte from the documented R10 layout (measurement, status, control point and battery characteristics), not recorded from a device.

It covers: battery reads, wake responses (`80 00 00`), ready/busy statuses, a full shot in one notification (id 1), a shot split across three notifications (id 2), a repeat of shot id 2, a ball-only shot with no club fields (id 3), a standby warning followed by a wake response, an error status with a UTF-8 message, and a shot split across two notifications (id 4) in the same layout as the recorded shots.

Split shots follow the format seen in `recorded-session.jsonl`: every notification is a complete measurement with its own flags word and shot id, carrying a subset of the fields, and bit 0 (`MORE_DATA`) of its flags is set when another notification for the same shot follows.

Real logs from the right- and left-handed push/pull sign test belong beside these files, named so the hand and shot shape are clear (for example `signtest-right-push.jsonl`).
