(set-logic QF_LIA)
(set-info :source "Ming 证明义务导出(QF_LIA 子集;规范见 docs/proof-protocol.md)")

; ===== 文件:refuted-sat.ming =====
; ---- vc:f:1 — 索引 n(scope: body)----
; 方向 low — ming 内部判定: unknown(内部未判定;外部结论不设期望)
(push)
(declare-const n Int)
(declare-const len$buf Int)
(assert (= n len$buf))
(assert (not (>= n 0)))
(check-sat)
(pop)
; 方向 high — ming 内部判定: refuted(内部判定违反方向被假设集强制;期望 sat——若外部 unsat,先核对假设集自身可满足性,见协议 §6.2 规则 4)
(push)
(declare-const n Int)
(declare-const len$buf Int)
(assert (= n len$buf))
(assert (not (< n len$buf)))
(check-sat)
(pop)

(exit)
