# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Running the apps

No build step — open HTML files directly in a browser:

```
d:/xx2/advance-tracker.html        # Employee advance tracker (mobile-first, v3.17)
d:/xx2/finance_app_v2-fixed_5.html # Company finance ledger (desktop+mobile, v2.19)
d:/xx2/ar-combined.html            # Accounts Receivable (v2.9.2)
d:/xx2/ap-combined.html            # Accounts Payable (v1.7)
```

Both apps are self-contained single-file HTML/CSS/JS. No server, no npm, no bundling.

---

## Architecture

### Apps & Firebase project

All apps share **Firebase project `advance-tracker-cadf5`** (Firestore). Firebase 9.23.0 compat SDK is loaded dynamically at runtime.

**Shared Firestore collections:**

| Collection | Owner / Writer | Purpose |
|---|---|---|
| `employees` | advance-tracker | Employee roster, salary, transactions |
| `advance_requests` | finance + advance-tracker | Advance disbursements (status: pending_approval / approved / rejected) |
| `advance_records` | advance-tracker | Repayment and clear records (`type`: `repayment` \| `clear`) |
| `advance_monthly/{YYYY-MM}/records/` | advance-tracker + finance | Monthly advance summaries |
| `fin_transactions` | finance app | Main finance ledger (authoritative) |
| `finance_transactions` | finance app | Cross-app intermediary (syncStatus field) |

AR app uses its own Firestore collections (invoices, customers, payments).  
AP app uses its own Firestore collections (bills, vendors).

### Data flow — Employee Advance (เบิกล่วงหน้า)

```
finance_app_v2-fixed_5.html                advance-tracker.html
         │                                          │
  fin_transactions  ←── write ──┐                  │
  finance_transactions          │    advance_requests ◄──── write ────┘
         │                      │    advance_records  ──── read ──────►
         └── shouldSyncAdvance? │    advance_monthly/{MM}/records/
              yes → createAdvanceRequest()
```

**shouldSyncAdvance()** คือ gate ของ sync — sync เฉพาะ:
- `tx.type === "employee_advance"`
- หรือ `tx.type === "payroll"` + category อยู่ใน `LEGACY_ADV_CATS`

```javascript
const LEGACY_ADV_CATS = ["เบิกล่วงหน้าเงินเดือน","เบิกค่าโปรเจ็กต์","เบิกด่วน","เบิกอื่นๆ"];
```

### Offline-first pattern

Both apps:
1. Load from localStorage on startup (`loadLocal()`)
2. Attempt Firebase reads; update localStorage on success
3. All writes go to localStorage immediately, then async to Firestore
4. `_hasPendingChanges` flag + 30s autosave + `beforeunload` handler

**localStorage keys — finance app:**
- `fin_txs` — transactions array
- `fin_employees` — employees array
- `fin_pending_ids` — IDs ที่ยังไม่ได้ sync ขึ้น Firestore (offline queue)
- `fin_sync_retry` — retry queue (max 5 ครั้งต่อ txId)

**localStorage keys — advance-tracker:**
- `advance_tracker_v2` — employees array
- `advance_requests_local` — requests array
- `advance_ledger_local` — ledger array
- `advance_records_local` — advance records array

### Sync paths — Employee Advance (ครบทุก path)

| Path | Trigger | Sync? |
|---|---|---|
| A | saveRight/saveForm (online, new tx) | 1× explicit `saveFinanceTransaction()` |
| B | saveRight/saveForm (online, edit) | 1× explicit |
| C | approveTx | update status only (merge) — ไม่ re-sync ทั้ง record |
| D | delTx | ลบจาก fin_transactions เท่านั้น — advance_requests ยังเก็บไว้ |
| E | flushPendingToFirebase (offline→online) | 1× ต่อ record, ไม่ซ้ำกับ Path A |
| F | beforeunload (ปิด tab) | flush pending แบบ fire-and-forget |
| G | Retry queue (loadFromFirebase / pullFromFirebase) | retry เฉพาะ failed records |
| H | Drive import (batch OCR) | 1× explicit ต่อ tx |
| I | syncAdvanceReqsForEmp | manual admin เท่านั้น |
| J | migrateOldData | one-time admin เท่านั้น |

**ยืนยัน: ไม่มี duplicate sync ในทุก path** (ตรวจสอบ 2026-05-27)

### Sync flow — createAdvanceRequest()

```
1. empId guard          → skip ถ้า employeeId และ empId ว่างทั้งคู่
2. existStatus get()    → อ่าน status เดิมจาก advance_requests ก่อน
3. advance_requests.set(req)  → ใช้ existStatus (ไม่ overwrite approved/rejected)
4. syncAdvance(tx)      → advance_monthly.set() (throws on error)
5. finance_transactions.set({syncStatus:"linked"}, merge)
   └── catch → addToSyncRetry() + set syncStatus:"error"
```

### Retry queue

- localStorage key: `fin_sync_retry`
- format: `[{txId, retryCount, lastError, createdAt}]`
- max retry: 5 ครั้ง → toast เตือน user ถ้า dead
- trigger: `loadFromFirebase()` + `pullFromFirebase()` → `processSyncRetryQueue()`

---

## File versions (current)

| File | Version | อัปเดตล่าสุด | หมายเหตุ |
|---|---|---|---|
| `finance_app_v2-fixed_5.html` | v2.19 | 2026-05-29 11:00 | advance sync fixes, status approved, resync month |
| `advance-tracker.html` | v3.17 | 2026-05-29 10:00 | dedup key fix, advance_monthly match |
| `ar-combined.html` | v2.9.2 | 2026-05-27 | admAddPmt/Del/Edit guard |
| `ap-combined.html` | v1.7 | 2026-05-27 | version date update |

---

## Bugs แก้แล้ว (2026-05-23 → 2026-05-27)

### HIGH

| # | Bug | Fix | Commit |
|---|---|---|---|
| H1 | empId/employeeId fallback หาย | `\|\|r.empId` ใน 7 จุด | bfb4ba7 |
| H2 | Race condition + ไม่มี retry | syncRetryQueue + syncAdvance rethrow | 9cedec2 |
| H3 | empId ว่าง sync ทะลุ | empId guard ใน createAdvanceRequest | bfb4ba7 |

### MEDIUM

| # | Bug | Fix | Commit |
|---|---|---|---|
| M7 | beforeunload ไม่ flush | flushPendingToFirebase() ใน beforeunload | bfb4ba7 |
| M8 | _localOnly index hardcode | ใช้ `req._localOnly` โดยตรง | bfb4ba7 |
| M9 | saveFinanceTransaction ไม่ await | async/await + Promise.all | bfb4ba7 |
| M12 | shouldSyncAdvance() string เปราะ | LEGACY_ADV_CATS array | bfb4ba7 |
| M13 | getEmpDisplay ค้าง "กำลังโหลด..." | แยก ไม่พบพนักงาน vs กำลังโหลด | bfb4ba7 |
| M14 | createAdvanceRequest reset status | existStatus check ก่อน set | bfb4ba7 |
| M5 | advance-tracker ไม่อ่าน advance_monthly | implement อยู่แล้ว | — |

### Sync ซ้ำซ้อน (แก้แล้ว)

| ปัญหา | สาเหตุ | Fix | Commit |
|---|---|---|---|
| Double sync ทุก save | saveTxs().then() เรียก sync ซ้ำกับ explicit call | ลบออกจาก saveTxs().then() | 7d2035b |
| Full re-sync ทุก action | approveTx/delTx/editCat เรียก saveTxs() → sync ทุก record | เดียวกัน | 7d2035b |
| Offline advance ไม่ sync | flushPendingToFirebase() ไม่เรียก createAdvanceRequest | เพิ่ม advance loop | 7d2035b |

### PLAUSIBLE / AR

| Bug | Fix | Commit |
|---|---|---|
| admAddPmt/Del/Edit bypass status | guard สำหรับ cancelled/draft invoice | — |

---

## Bugs ที่ตัดสินใจไม่แก้ (ไม่กระทบการใช้งานหลัก)

| # | Bug | เหตุผล |
|---|---|---|
| MED #4 | Finance ไม่แสดง advance_records (repayment) | ต้องสร้าง UI ใหม่ ยังไม่ urgent |
| MED #6 | Schema drift — advance-tracker เขียน advance_requests ไม่มี `transferDate` | แก้แล้วบางส่วน (เพิ่ม transferDate ใน 2 write path) |
| MED #11 | No conflict resolution สำหรับ employees (last-write-wins) | edge case ไม่บ่อย |

---

## Known gaps (ไม่ใช่ bug ใหม่)

- **delTx ≠ delete advance_requests**: ลบ tx ใน finance ไม่ลบ advance_requests → advance-tracker ยังเห็น record นั้น
- **Drive import ไม่ผ่าน fin_transactions**: เขียน finance_transactions เท่านั้น (pre-existing)
- **2 writes ต่อ advance ใน finance_transactions**: write full doc + write `{syncStatus}` merge — ไม่ใช่ bug แต่ต้นทุน 2 write

---

## Next steps (ถ้าจะพัฒนาต่อ)

1. **MED #4** — เพิ่ม UI แสดง repayment history (advance_records) ใน Finance app
2. **delTx cleanup** — เมื่อ finance ลบ employee_advance ให้ update status ใน advance_requests เป็น `cancelled`
3. **Drive import → fin_transactions** — รวม path เข้า saveTxs() ด้วย
4. **Conflict resolution** — เพิ่ม `updatedAt` check ก่อน overwrite employees

---

## Key conventions

- UI language: Thai (th). All user-facing strings, labels, and toast messages are in Thai.
- IDs use the `uid()` helper to generate unique record IDs.
- Monetary amounts stored as plain numbers (THB); display uses `toLocaleString('th-TH')`.
- Month keys: `YYYY-MM` format (e.g. `2026-05`).
- Dates: `YYYY-MM-DD` (ISO) in storage; displayed in Thai Buddhist calendar format in UI.
- Employee ID field: ใช้ `employeeId` เป็น primary, `empId` เป็น fallback ทุกที่ (เพิ่งแก้)

### Version stamping

Each file has `BUILD_TIME` and `BUILD_LABEL` variables near the top of the `<script>` block. Update these when shipping a new version.

---

## OCR

Anthropic Claude API (`claude-3-5-sonnet` or similar) reads slip images. API key stored in `localStorage` only — never hardcoded. User sets it in Settings tab.

Finance app additionally supports **Google Drive Folder Import**: batch OCR of all images in a Drive folder using a Google Cloud API Key (also in localStorage). Duplicate detection uses `referenceNo`, `slipFileId`, or `amount+date+receiver`.

---

## Backup

`d:/xx2/backup/` contains previous versions. The active files are always in `d:/xx2/` root.

---

## Other projects in this repo

| Directory | Project | Status |
|---|---|---|
| `d:/xx2/proforma-app/` | Pro forma app (3 tabs A/B/C, CF statement, Excel 4-sheet, PDF 5-page) | v1.1 stable |
| `d:/xx2/live-tv/` | SX Admin + TV app (Firebase: live-tv-app-d1d10) | ค้าง: Firestore rules + login system |
