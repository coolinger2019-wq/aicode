(set-logic QF_LIA)
(set-info :source "Ming 证明义务导出(QF_LIA 子集;规范见 docs/proof-protocol.md)")

; ===== 文件:unknown.ming =====
; ---- vc:g:1 — 索引 n(scope: body)----
; 方向 low — ming 内部判定: unknown(内部未判定;外部结论不设期望)
(push)
(declare-const n Int)
(declare-const len$buf Int)
(assert (<= n len$buf))
(assert (not (>= n 0)))
(check-sat)
(pop)
; 方向 high — ming 内部判定: unknown(内部未判定;外部结论不设期望)
(push)
(declare-const n Int)
(declare-const len$buf Int)
(assert (<= n len$buf))
(assert (not (< n len$buf)))
(check-sat)
(pop)

(exit)
