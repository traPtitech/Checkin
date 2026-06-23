## ADDED Requirements

### Requirement: 入金時に発行台帳を paid 確定

システムは、`invoice.paid` を正常受信・検証したとき、その Invoice に対応する発行台帳（[[issuance-ledger]]）のスロットを **paid** に確定 SHALL。確定は当該 Invoice の全スロット（通期なら前期・後期の両方）に及び、冪等とする（既に paid のスロットへの再適用は副作用を持たない）MUST。台帳に対応スロットが無い Invoice（台帳導入前や台帳外の発行）は確定をスキップし、受信自体は成功（200）として扱う SHALL。台帳確定は会計通知とは独立で、一方の失敗が他方を壊しては SHALL NOT。

#### Scenario: 入金で台帳が paid になる

- **WHEN** 発行台帳に対応する Invoice について、検証済みの `invoice.paid`（未処理 event id）を受信する
- **THEN** その発行の全スロットが paid に確定され、会計通知も発火する

#### Scenario: 台帳外の Invoice はスキップ

- **WHEN** 発行台帳に対応スロットが無い Invoice の `invoice.paid` を受信する
- **THEN** 台帳確定はスキップされ、受信は成功（200）として扱われる

#### Scenario: 再送の paid 確定は冪等

- **WHEN** 既に paid のスロットに対応する `invoice.paid` が再送される
- **THEN** スロットは paid のまま変わらず、二重の副作用は起きない
