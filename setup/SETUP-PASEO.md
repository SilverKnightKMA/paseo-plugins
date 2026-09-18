# SETUP-PASEO — cài Paseo daemon + plugin từ đầu (phần 2/2)

> **⚠️ Hệ 2 repo — repo này đơn lẻ KHÔNG chạy được.**
> Plugin trong repo (task, plan, agent-health, om-panel, om-status, snip, lessons) render dữ liệu do extension phía **pi-config** sinh ra: task-status/goal-status/plan-control projection, MARKERS timeline transformer, OM ledger. Chưa cài pi pack thì plugin không có gì để hiển thị và hệ wake/task không hoạt động.
> **Bắt buộc phải làm trước:** [`SETUP-PI.md` trong repo pi-config](https://github.com/SilverKnightKMA/pi-config/blob/main/setup/SETUP-PI.md)

Hướng dẫn dành cho **agent** đọc và tự thực hiện trên máy sạch — **Linux, macOS, Windows native** (PowerShell).

## 0. Prerequisites

- Node.js ≥ 20 + npm (đã có nếu bạn vừa xong SETUP-PI)
- Path theo OS: Linux/macOS `~/.paseo/…` · Windows native `%USERPROFILE%\.paseo\…`

## 1. Cài Paseo CLI (kèm daemon)

```bash
npm install -g @getpaseo/cli
paseo --version
```

## 2. First-time setup

```bash
paseo onboard
```

Một lệnh: setup lần đầu + start daemon + in pairing instructions. Xong kiểm tra:

```bash
paseo status
```

## 3. Cài 7 plugin từ repo này

```bash
paseo plugin add SilverKnightKMA/paseo-plugins:agent-health --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:om-panel --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:om-status --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:plan --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:snip --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:task --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:lessons --ref v1.0.57
```

(`--ref v1.0.57` là tag tại thời điểm viết; thay bằng tag mới nhất trong repo nếu có. Daemon tự ghi registry vào config — **không** copy thủ công phần `plugins` của config từ máy khác: path checkout chứa UUID riêng của mỗi máy.)

## 4. Đặt config từ samples

| File đích | Nguồn sample | Ghi chú |
|---|---|---|
| `~/.paseo/config.json` | `setup/samples/paseo-config.json` | **MERGE, không ghi đè**: giữ nguyên khối `plugins` daemon vừa tự ghi ở bước 3. Relay là tùy chọn — truy cập app từ ngoài LAN thì đi qua relay tự host, chỉ dùng local thì bỏ hẳn khối `relay` |
| `~/.paseo/orchestration-preferences.json` | `setup/samples/paseo-orchestration-preferences.json` | Điền `<PROVIDER>/<MODEL>` theo model bạn đã cấu hình bên pi (hỏi user, không tự bịa) |

Sau khi sửa config: `paseo reload`.

Bảng FILL-IN:

| Placeholder | Lấy từ đâu |
|---|---|
| `<YOUR-RELAY-HOST>:443` | Relay Paseo tự host của user (nếu có); bỏ khối relay nếu không dùng |
| `<PROVIDER>/<*-MODEL>` | Model user đăng ký ở `~/.pi/agent/models.json` (phần SETUP-PI) |
| `terminalProfiles` | Sample giữ 4 profile mẫu (tmux/claude/codex/opencode) — giữ những CLI thật có trên máy, thêm profile tùy ý |

## 5. Verify

```bash
paseo plugin ls          # 7 plugin: agent-health, om-panel, om-status, plan, snip, task, lessons — trạng thái running
paseo status             # daemon running, config.json load sạch
```

Paseo app (app.paseo.sh) mở workspace: panel **Tasks**, **Plans**, **OM Topics**, **Lessons**, **Snip** phải hiện — panel trống hoàn toàn nghĩa là phía pi-config chưa cài (quay lại SETUP-PI).

## 6. KẾT LUẬN — join link cho user dùng ngay

Hệ đã đủ điều kiện khi: `pi -p` trả lời OK (SETUP-PI bước 5) + `paseo plugin ls` đủ 7 running + `paseo status` running. Lúc đó in pairing cho user:

```bash
paseo daemon pair
```

Lệnh in **QR code + join link** của daemon. Agent trình lại cho user theo mẫu:

> Daemon đã sẵn sàng. Mở Paseo app → **Add host** → quét QR hoặc dán link trên → dùng được ngay.

Nếu user kết nối từ máy khác qua relay: link mang public endpoint của relay — gửi link đó, user dán vào app ở bất kỳ đâu.

---

## Migrate Paseo state từ máy cũ (optional, không nằm trong repo)

| Nhóm | File/thư mục | Bắt buộc? |
|---|---|---|
| Config | `config.json`, `orchestration-preferences.json`, `daemon-keypair.json`, `server-id`, `cli-client-id`, `push-tokens.json`, `projects/`, `plugin-data/` | Khuyến nghị — giữ danh tính daemon với relay + cấu hình |
| Plugin checkouts | `plugins/` (15M) | Không — `paseo plugin add` tự checkout đúng path máy mới |
| Dữ liệu | `uploads/`, `agents/` | Tùy — file user upload / lịch sử agent |
| Rác | `*.log`, `runtime/`, `recovery-*`, `*.bak.*`, `paseo.pid` | Bỏ lại |

Lưu ý: merge `config.json` cũ vào máy mới theo hướng bước 4 (giữ registry plugin mới, không copy path UUID cũ).
