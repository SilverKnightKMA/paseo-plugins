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
| `~/.paseo/config.json` | `setup/samples/paseo-config.json` | **MERGE, không ghi đè**: giữ nguyên khối `plugins` daemon vừa tự ghi ở bước 3. Relay LUÔN bật — mặc định đi qua relay chính thức của Paseo (`relay.paseo.sh:443`, daemon onboard tự đặt giá trị này); nếu bạn vận hành relay riêng thì chỉ thay 2 field `endpoint`/`publicEndpoint` bằng host relay của mình |
| `~/.paseo/orchestration-preferences.json` | `setup/samples/paseo-orchestration-preferences.json` | Điền `<PROVIDER>/<MODEL>` theo model bạn đã cấu hình bên pi (hỏi user, không tự bịa) |

Sau khi sửa config: `paseo reload`.

Bảng FILL-IN:

| Placeholder | Lấy từ đâu |
|---|---|
| `relay.paseo.sh:443` | Giữ nguyên mặc định (relay chính thức Paseo). Chỉ thay bằng `<YOUR-RELAY-HOST>:443` khi bạn tự vận hành relay — không hardcode host riêng vào config chia sẻ công khai |
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

## 7. Import session setup này vào Paseo

Session pi đang chạy hướng dẫn này KHÔNG tự hiện trong Paseo app (chạy từ terminal). Import nó để user thấy toàn bộ lịch sử setup trong app:

```bash
# 1. Tìm session id pi mới nhất của workspace đang chạy
#    (thư mục session = cwd bị slug hóa: /home/you/workspaces/foo -> --home-you-workspaces-foo--)
ls -t ~/.pi/agent/sessions/ | head -5
# 2. Vào thư mục khớp cwd, file mới nhất có dạng <timestamp>_<sessionId>.jsonl
SESSION_ID=$(basename "$(ls -t <thư-mục-session>/*.jsonl | head -1)" | sed 's/.*_//; s/\.jsonl//')
# 3. Import (đã verify: tạo agent entry hiện trong app; chạy 2 lần không sao — daemon tự chặn trùng)
paseo import "$SESSION_ID" --provider pi
```

Agent trình user: *"Session setup đã được import — mở Paseo app sẽ thấy toàn bộ quá trình cài đặt như một agent bình thường."* Nếu import nhầm session, dọn bằng `paseo archive <agentId>`.

### Import hàng loạt / provider khác (optional)

**Subagent hiện tại KHÔNG cần import** — `spawn_subagent` luôn đi qua
`paseo_create_agent` nên child được đăng ký live với labels
`subagent.role`/`subagent.parent` ngay từ lúc spawn. Session subagent chỉ
sót lại trên đĩa khi thuộc thời spawn trực tiếp cũ (pre-MCP): user-message
ĐẦU TIÊN là role prompt (vd `"You are a research specialist. Given a
question or topic, conduct..."`). Xử lý (theo chỉ thị user 2026-09-19):
import bình thường + `--label subagent.role=researcher` rồi ARCHIVE NGAY
qua MCP `paseo_archive_agent` để khỏi nhìn thấy trong list chính (CLI
`paseo archive` không với tới agent closed — lỗi "Agent not found" đã verify).

Cùng một lệnh cho mọi provider đang bật trong daemon — chỉ đổi `--provider` (pi, omp, codex, opencode, copilot, claude…) và nguồn file session theo từng nhà cung cấp. Import trùng bị daemon tự chặn ("already imported") nên loop an toàn. Mặc định: **mọi session trừ OM worker** (các dir `.memory-*` — session nội bộ của observational-memory, import sẽ hỏi fork tương tác):

```bash
# Bước 1 — build queue offline: mỗi dòng "provider<TAB>sessionId<TAB>cwd"
# (cwd đọc từ chính JSONL — BẮT BUỘC: session thuộc workspace khác mà thiếu --cwd
#  thì daemon hỏi "Fork this session...?" tương tác và abort khi chạy nền)
python3 - <<'PY'
import glob, os, re, json
from collections import Counter
# BỎ judge/one-shot — TIN HIỆU HẠNG NHẤT (pi-config v1.4.101+): mọi lần spawn judge
# GHI 1 dòng registry ~/.pi/agent/judge-sessions.jsonl {ts,cwd,path} và pin
# session vào subdir --judge--. Filter đọc registry + bỏ cả subdir đó; KHÔNG
# dò đoán nội dung. Fingerprint 6-record bên dưới CHỈ là fallback cho judge
# sinh TRƯỚC v1.4.101 (máy cũ chưa có registry).
REG = os.path.expanduser('~/.pi/agent/judge-sessions.jsonl')
judge_paths = set()
try:
    for line in open(REG):
        try: judge_paths.add(json.loads(line)['path'])
        except: pass
except FileNotFoundError: pass
ONE_SHOT = {'session':1,'model_change':1,'thinking_level_change':1,'message':2,'custom_message':1}
def is_one_shot(f):
    c = Counter()
    with open(f) as fh:
        for line in fh:
            try: c[json.loads(line).get('type')] += 1
            except: return False
    return dict(c) == ONE_SHOT
q = []
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    if '.memory-' in f: continue          # bỏ OM worker
    if '/--judge--/' in f or f in judge_paths: continue   # bỏ judge (registry v1.4.101+)
    if is_one_shot(f): continue           # fallback: judge cũ pre-v1.4.101
    sid = re.sub(r'.*_','',os.path.basename(f)).replace('.jsonl','')
    head = open(f,'rb').read(4000).decode('utf8','ignore')
    m = re.search(r'"cwd":"([^"]*)"', head)
    q.append(f"pi\t{sid}\t{m.group(1) if m else ''}")
open(os.path.expanduser('~/bulk-import-queue.tsv'),'w').write('\n'.join(q))
PY

# Bước 2 — import có throttle, log vào ~/ (không dùng /tmp — mất khi restart)
setsid nohup bash -c '
while IFS=$'"'"'\t'"'"' read -r PROV ID CWD; do
  paseo import "$ID" --provider "$PROV" ${CWD:+--cwd "$CWD"} 2>&1 | grep -qE "created|already" || echo "ERR $ID"
  sleep 1
done < ~/bulk-import-queue.tsv
echo BULK-DONE' > ~/bulk-import.log 2>&1 &
tail ~/bulk-import.log   # theo dõi
```

Lưu ý (verify trên store thật 2600 session): mỗi import là 1 RPC — throttle `sleep 1` để daemon không đơ (đã bẻ container một lần khi chạy dồn dập); session có cwd đã bị xóa (vd `/tmp/...` test cũ) sẽ ERR — bỏ qua được; mọi import hiện thành agent active trong app (list dài là tradeoff đã chấp nhận, dọn bằng `paseo archive <agentId>`).

---

## Migrate Paseo state từ máy cũ (optional, không nằm trong repo)

| Nhóm | File/thư mục | Bắt buộc? |
|---|---|---|
| Config | `config.json`, `orchestration-preferences.json`, `daemon-keypair.json`, `server-id`, `cli-client-id`, `push-tokens.json`, `projects/`, `plugin-data/` | Khuyến nghị — giữ danh tính daemon với relay + cấu hình |
| Plugin checkouts | `plugins/` (15M) | Không — `paseo plugin add` tự checkout đúng path máy mới |
| Dữ liệu | `uploads/`, `agents/` | Tùy — file user upload / lịch sử agent |
| Rác | `*.log`, `runtime/`, `recovery-*`, `*.bak.*`, `paseo.pid` | Bỏ lại |

Lưu ý: merge `config.json` cũ vào máy mới theo hướng bước 4 (giữ registry plugin mới, không copy path UUID cũ).
