# BACKLOG — paseo-plugins deferred items

Created 2026-09-24 alongside ADR records (#288). Until now cross-repo pending
items lived in pi-config/BACKLOG.md with `repo: paseo-plugins` tags — new ones
land HERE. Promote to a board task when its trigger fires.

## Plugin pin không tự theo tag repo (phát hiện 2026-09-24)

repo: paseo-plugins · mở: 2026-09-24 · nguồn: audit "managed tool install có làm mất yêu cầu?" (#283 follow-up)

`paseo plugin update <id>` KHÔNG nhảy ref — plugin git pin theo ref ghi lúc install. lessons kẹt v1.0.56 suốt 3 ngày (thiếu cbb70a3 dịch #172, verdict user) dù repo lên v1.0.97; phải `paseo plugin remove` + `install --ref v1.0.97`. Đã chạy 2026-09-24, toàn fleet 10 plugin giờ mới nhất cho từng plugin.

**Trigger làm:** mỗi lần tag release mới, reinstall các plugin có diff `git diff <pin> HEAD -- <dir>` (audit 1 dòng), hoặc cân nhắc cài plugin theo branch main thay vì tag. Chú ý risk: remove+install downtime vài giây.
