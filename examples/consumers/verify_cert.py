#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_cert.py — Ming 线性不可满足证书的**第二语言独立验证器**（Python 3，仅标准库）。

规范：docs/proof-protocol.md §10（判据 = 冻结面，§10.2/§10.3）。
本脚本不 import、不调用任何 Ming / Node 代码，只读两件纯文本工件：

  证书        ming check f.ming --proof-format cert               （必给）
  SMT 脚本    ming check f.ming --proof-format smt-lib            （可选；对照模式用）

两种模式：

  对照模式（给了 --smt <脚本>）
      按 §10.3 独立解析 SMT 子集（只消费 push/declare/assert/check-sat/pop 命令面），
      对每条引用按**断言序号 + 归一方向**重算归一后的行 `Σ c x <= K`，
      与证书声明的 `norm:` 行逐项对照（**不信任证书里的系数**），
      再重算 §10.2 的两条量：`Σ λ_i c_i = 0`（逐变量恒等）与 `Σ λ_i K_i < 0`。
      另外机械核验 uses_goal（引用了块内末条断言 ⟺ 取反目标被用到）。

  仅自洽模式（不给 --smt）
      只按证书**声明**的行重算 Σλc/ΣλK 并核对自述 identity 行。
      这一模式**无法**发现：系数被篡改、引用序号越界（块外引用）——
      它证明的只是"证书内部自述是自洽的"，输出会逐行标注这一点。

判据本身（§10.2，冻结）：
  设某方向断言集 A = [a_1 … a_m]（块内序，a_m 是取反目标），证书给引用 (i_t, d_t) 与 λ_t ∈ ℕ。
  ① 每条引用按 §10.3 归一为 `Σ c x <= K`（`(< a b)` ⇒ `a-b <= -1`，整数语义，是判据的一部分）；
  ② 逐变量恒等：Σ_t λ_t c_t = 0；
  ③ 负常数和：Σ_t λ_t K_t < 0。
  三条同时成立 ⇒ A 在整数域不可满足。只走"实数不可行 ⇒ 整数不可行"方向（ℤⁿ ⊆ ℝⁿ），
  故**绝不会误证**，代价只落在完全性。本实现产出的 λ 恒为 1（判据允许 λ > 1，按 λ 累加）。

深度边界（不夸大）：证书只证"该义务**按本协议编码后**的约束集不可满足"——
不证 AST→约束的忠实性、不证运行时安全（proven 不消除 M4003），不是程序正确性证明。

用法：
  python examples/consumers/verify_cert.py <证书> [--smt <smt-lib 脚本>]
  python examples/consumers/verify_cert.py --help

退出码：0 = 通过；1 = 任一判据/结构失败、输入不可读、用法错误。
确定性：同一输入恒产出逐字节相同的输出（无时间戳、无随机序、变量按码位序）。
编码：启动即把 stdout/stderr 固定为 UTF-8（errors=backslashreplace）——任何终端/管道
      locale（cp1252/ascii/gbk…）都不会因编码崩溃，输出字节恒为 UTF-8（非 UTF-8 终端可能
      显示转义符）；读入按 UTF-8 解码，行尾 CRLF/孤立 CR 归一为 LF。
纪律：错误走 stderr 并具名；本脚本零第三方依赖。
"""

import re
import sys

# ---- 冻结常量（逐字取自 docs/proof-protocol.md §10.1/§10.5 与 tests/cert_fixtures/*.cert） ----

CERT_HEAD = '; ===== Ming 线性不可满足证书(cert v1)====='
NO_CERT_PREFIX = '; 无证书:'
ZERO_OBLIGATION_LINE = '; 无证明义务'
CERT_HEADER_PREFIXES = ('; spec:', '; 判据:', '; 归一:', '; 覆盖边界:', '; 有效性:', '; 引用序号')
IDENTITY_COEFF_TEXT = '0(逐变量恒等)'

# S-表达式嵌套界（与 Ming parser 的 120 层守卫同量级；防深嵌套输入的栈耗尽）。
MAX_SEXP_DEPTH = 120

# 数字原子：只认 ASCII 十进制（`'²'.isdigit()` 为真但 `int()` 会抛 ValueError——
# 判据里的字面量是 ASCII，非 ASCII 数字按普通符号处理，绝不进 int()）。
RE_DIGITS = re.compile(r'^[0-9]+$')


def is_digits(text):
    return isinstance(text, str) and RE_DIGITS.match(text) is not None

# 无证书原因的登记集（§10.5 表 + refuted/unknown 两条判定态）。
# 未登记措辞 = 失败：验证器不替生产者发明/容忍新说法。
NO_CERT_REASONS = (
    'refuted 方向无不可满足性证书(内部判定:违反方向被假设集强制)',
    '内部未判定(unknown;目标未编码或超出差分片段)',
    '常量矛盾(constFalse;LHS 为空的单条矛盾断言,v1 不渲染该形态)',
    '判定来源无单一负环(防御路径;cycle 为空)',
    '目标为 == 双向拆分证明(两向各自成立,无单一负环)',
    '目标取反为合取(!=;无单一负环)',
    '该方向的假设集含不可渲染为 SMT 断言的形态(!= 等),断言序号无法与 smt-lib 块对齐(v1 不产证书)',
    '证书数据缺失(内部一致性缺口——不应出现,请报告)',
)

DUAL = {'>=': '<', '<': '>=', '<=': '>', '>': '<='}
COMPARATORS = ('=', '<', '<=', '>', '>=')

USAGE = '\n'.join([
    '用法:python examples/consumers/verify_cert.py <证书> [--smt <smt-lib 脚本>]',
    '',
    'Ming 线性不可满足证书的独立验证器(判据:docs/proof-protocol.md §10;第二语言实现,零依赖)。',
    '',
    '  对照模式(--smt <脚本>)',
    '      从 SMT 脚本重算每个被引用断言的归一(§10.3)并与证书声明逐项对照,',
    '      再重算 Σλc = 0(逐变量)与 ΣλK < 0。不信任证书里的任何数字。',
    '  仅自洽模式(不给 --smt)',
    '      只按证书声明的行做恒等式自洽校验;系数篡改与块外引用无法发现(输出会标注)。',
    '',
    '示例:',
    '  python examples/consumers/verify_cert.py tests/cert_fixtures/proven.cert',
    '  python examples/consumers/verify_cert.py tests/cert_fixtures/loop.cert --smt tests/proof_fixtures/loop.smt2',
    '',
    '退出码:0 = 通过;1 = 失败/输入不可读/用法错误。',
    '编码:输出恒为 UTF-8(任何 locale 下都不因编码失败;非 UTF-8 终端可能显示转义)。',
    '边界:证书只证"该义务按本协议编码后的约束集在整数域不可满足"——',
    '      不证编码忠实于源码、不证运行时安全,不是程序正确性证明。',
])


class CertError(Exception):
    """输入文本不符合协议形态（解析层失败）。"""


# ---- stdio 编码固定（M1） -------------------------------------------------------------------
# 不依赖终端/PYTHONIOENCODING：输出恒 UTF-8，不可编码字符回退为反斜杠转义
# （errors=backslashreplace 在本脚本下实际不触发——强制 UTF-8 后全部字符可编码——
#  保留它是为了 reconfigure 只部分成功时的最后一道防线/确定性）。
def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='backslashreplace')
        except (AttributeError, ValueError, OSError):
            pass  # 极端环境（流被替换/已关闭）：继续，不因编码设施缺失而崩


_ESCAPES = {'\t': '\\t', '\n': '\\n', '\r': '\\r'}


def vis(text):
    """把控制字符转成可见转义（错误消息里不出现不可见的 \\r/\\0 等）。"""
    out = []
    for ch in text:
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif ord(ch) < 0x20 or ord(ch) == 0x7f:
            out.append('\\x%02x' % ord(ch))
        else:
            out.append(ch)
    return ''.join(out)


def clip(text, limit=140):
    if text is None:
        return '(无)'
    safe = vis(text)
    return safe if len(safe) <= limit else safe[:limit - 1] + '…'


# ---- 文本读取（UTF-8 / 去 BOM / 行尾归一；不可读 = 具名失败） --------------------------------

def read_text(path, what):
    try:
        with open(path, 'rb') as fh:
            data = fh.read()
    except OSError as exc:
        raise CertError('%s不可读:%s(%s)' % (what, path, exc.strerror or exc))
    if data.startswith(b'\xef\xbb\xbf'):
        data = data[3:]
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise CertError('%s不是 UTF-8 文本:%s(%s)' % (what, path, exc))
    # Windows 工具链/编辑器默认 CRLF：归一到 LF 后再按行解析（SMT 侧同口径；
    # 否则行尾的不可见 \r 会让"肉眼相同"的错误行号与消息对不上）。
    return text.replace('\r\n', '\n').replace('\r', '\n')


# ---- 线性行：{变量: 系数} + 常数 K ---------------------------------------------------------
# 行 = 归一后的 `Σ c x <= K`。系数为 Python int（任意精度，对应判据里的整数算术）。

def row_add(dst_coeffs, src_coeffs, sign):
    for name, val in src_coeffs.items():
        nv = dst_coeffs.get(name, 0) + sign * val
        if nv == 0:
            dst_coeffs.pop(name, None)
        else:
            dst_coeffs[name] = nv


def lin_of_term(term):
    """S-表达式项 → (coeffs, c)：`+` / `-`（一元/二元）/ `*`（常量×变量）/ 十进制字面量 / 符号。"""
    if isinstance(term, list):
        if not term:
            raise CertError('空 S-表达式')
        head = term[0]
        args = term[1:]
        if head == '+':
            coeffs = {}
            c = 0
            for arg in args:
                sub_coeffs, sub_c = lin_of_term(arg)
                row_add(coeffs, sub_coeffs, 1)
                c += sub_c
            return coeffs, c
        if head == '-':
            if len(args) == 1:
                coeffs, c = lin_of_term(args[0])
                return {k: -v for k, v in coeffs.items()}, -c
            if len(args) == 2:
                a_coeffs, a_c = lin_of_term(args[0])
                b_coeffs, b_c = lin_of_term(args[1])
                coeffs = dict(a_coeffs)
                row_add(coeffs, b_coeffs, -1)
                return coeffs, a_c - b_c
            raise CertError("不支持的 '-' 元数:%d" % len(args))
        if head == '*':
            if len(args) != 2:
                raise CertError("不支持的 '*' 元数:%d" % len(args))
            a, b = args
            if is_digits(a):
                coeffs, c = lin_of_term(b)
                k = int(a)
            elif is_digits(b):
                coeffs, c = lin_of_term(a)
                k = int(b)
            else:
                raise CertError('乘法只支持常量×变量')
            return {name: val * k for name, val in coeffs.items()}, c * k
        raise CertError('未知运算:%s' % (head if isinstance(head, str) else '<嵌套头>'))
    if isinstance(term, str):
        if is_digits(term):
            return {}, int(term)
        if term.startswith('-') and is_digits(term[1:]):
            raise CertError('数字字面量带符号(协议只发 (- n)):%s' % clip(term))
        return {term: 1}, 0
    raise CertError('非法的项类型:%r' % (term,))


def rows_of_predicate(pred):
    """比较谓词 → 归一后的行列表（§10.3 独立实现；`(= a b)` 拆双向 d0/d1）。"""
    node = pred
    negated = False
    while isinstance(node, list) and node and node[0] == 'not':
        negated = not negated
        if len(node) != 2:
            raise CertError("'not' 的元数不是 1")
        node = node[1]
    if not isinstance(node, list) or len(node) != 3:
        raise CertError('谓词形状不是 (op a b)')
    op = node[0]
    if not isinstance(op, str):
        raise CertError('比较符不是原子')
    lhs, rhs = node[1], node[2]
    if negated:
        if op == '=':
            raise CertError('not (= a b) 不可归一为单个线性约束')
        op = DUAL.get(op)
        if op is None:
            raise CertError('取反后比较符未知:%s' % (node[0],))
    if op not in COMPARATORS:
        raise CertError('未知比较符:%s' % op)
    d_coeffs, d_c = lin_of_term(lhs)
    r_coeffs, r_c = lin_of_term(rhs)
    row_add(d_coeffs, r_coeffs, -1)   # d = lhs - rhs（Σ c x + d）
    d_c -= r_c
    if op == '<=':
        return [(dict(d_coeffs), -d_c)]
    if op == '<':
        return [(dict(d_coeffs), -d_c - 1)]
    if op == '>=':
        return [({name: -val for name, val in d_coeffs.items()}, d_c)]
    if op == '>':
        return [({name: -val for name, val in d_coeffs.items()}, d_c - 1)]
    # '='：d0 = a-b <= 0，d1 = b-a <= 0
    return [(dict(d_coeffs), -d_c), ({name: -val for name, val in d_coeffs.items()}, d_c)]


# ---- S-表达式最小解析（只覆盖 proofsmt.js 的输出面：符号/数字/括号） -------------------------

def sexp_parse(text):
    toks = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in ' \t\r\n':
            i += 1
            continue
        if ch in '()':
            toks.append(ch)
            i += 1
            continue
        j = i
        while j < n and text[j] not in ' \t\r\n()':
            j += 1
        toks.append(text[i:j])
        i = j
    pos = [0]

    def parse(depth=1):
        if depth > MAX_SEXP_DEPTH:
            raise CertError('S-表达式嵌套过深(>%d 层)' % MAX_SEXP_DEPTH)
        if pos[0] >= len(toks):
            raise CertError('S-表达式意外结束')
        tok = toks[pos[0]]
        if tok == '(':
            pos[0] += 1
            out = []
            while pos[0] < len(toks) and toks[pos[0]] != ')':
                out.append(parse(depth + 1))
            if pos[0] >= len(toks):
                raise CertError('S-表达式括号不配平(缺右括号)')
            pos[0] += 1
            return out
        if tok == ')':
            raise CertError('S-表达式括号不配平(多余的右括号)')
        pos[0] += 1
        return tok

    out = []
    while pos[0] < len(toks):
        out.append(parse())
    return out


# ---- SMT 脚本结构解析（与 §3.1 结构不变式同款；只消费命令面，注释内容不解析） ----------------

def parse_smt_blocks(text):
    """→ [{file, vc, dir, verdict, asserts: [谓词文本...]}]，顺序 = 脚块序。"""
    lines = [ln.strip() for ln in text.split('\n')]
    non_empty = [ln for ln in lines if ln != '']
    if not non_empty:
        raise CertError('SMT 脚本为空')
    if non_empty[0] != '(set-logic QF_LIA)':
        raise CertError('SMT 脚本首行不是 (set-logic QF_LIA)(得到 %s)' % clip(non_empty[0]))
    if non_empty[-1] != '(exit)':
        raise CertError('SMT 脚本末行不是 (exit)(得到 %s)' % clip(non_empty[-1]))
    blocks = []
    cur_file = None
    cur_vc = None
    pending_dir = None
    pending_verdict = None
    cur = None
    for idx, line in enumerate(lines):
        if line == '':
            continue
        if line.startswith('; ===== 文件:'):
            if not line.endswith(' ====='):
                raise CertError('第 %d 行文件节形状不符:%s' % (idx + 1, clip(line)))
            cur_file = line[len('; ===== 文件:'):-len(' =====')]
            cur_vc = None
            pending_dir = None
            continue
        if line.startswith('; ---- vc:'):
            m = line[len('; ---- vc:'):]
            if ' — ' not in m:
                raise CertError('第 %d 行义务节形状不符:%s' % (idx + 1, clip(line)))
            vc_part = m.split(' — ', 1)[0]
            if vc_part.count(':') != 1 or not is_digits(vc_part.split(':')[1]):
                raise CertError('第 %d 行义务 id 形状不符:%s' % (idx + 1, clip(line)))
            cur_vc = 'vc:' + vc_part
            pending_dir = None
            continue
        if line.startswith('; 方向 '):
            m = line[len('; 方向 '):]
            if ' — ming 内部判定: ' not in m:
                raise CertError('第 %d 行方向头形状不符:%s' % (idx + 1, clip(line)))
            rest = m.split(' — ming 内部判定: ', 1)
            if rest[0] not in ('low', 'high'):
                raise CertError('第 %d 行方向名不是 low/high:%s' % (idx + 1, clip(line)))
            pending_dir = rest[0]
            verdict = rest[1].split('(', 1)[0]
            if verdict not in ('proven', 'refuted', 'unknown'):
                raise CertError('第 %d 行内部判定未知:%s' % (idx + 1, clip(line)))
            pending_verdict = verdict
            continue
        if line == '(push)':
            if pending_dir is None:
                raise CertError('第 %d 行 (push) 前没有方向头注释' % (idx + 1))
            cur = {'file': cur_file, 'vc': cur_vc, 'dir': pending_dir,
                   'verdict': pending_verdict, 'asserts': []}
            blocks.append(cur)
            pending_dir = None
            continue
        if line == '(pop)':
            if cur is None:
                raise CertError('第 %d 行 (pop) 没有对应的 (push)' % (idx + 1))
            cur = None
            continue
        if cur is not None and line.startswith('(assert '):
            if not line.endswith(')'):
                raise CertError('第 %d 行 assert 未闭合:%s' % (idx + 1, clip(line)))
            cur['asserts'].append(line[len('(assert '):-1].strip())
            if cur['asserts'][-1] == '':
                raise CertError('第 %d 行 assert 体为空' % (idx + 1))
            continue
        # 其余命令（declare-const / check-sat / set-info）不进入复核面；
        # 注释行（; 起行）按 §3.1 不变式 4「注释不进入求解器状态」忽略——只解析上面三种
        # 结构注释。出现未知**命令**则具名拒绝：不静默跳过（跳过可能掩盖结构破坏）。
        if line.startswith(';'):
            continue
        if cur is not None and (line.startswith('(declare-const ') or line == '(check-sat)'):
            continue
        if line.startswith('(set-info ') or line in ('(set-logic QF_LIA)', '(exit)'):
            continue
        raise CertError('第 %d 行未识别的命令/注释:%s' % (idx + 1, clip(line)))
    if cur is not None:
        raise CertError('SMT 脚本有未闭合的 (push) 块')
    for b in blocks:
        if not b['asserts']:
            raise CertError('%s|%s/%s: 方向块没有任何断言' % (b['file'], b['vc'], b['dir']))
        if b['dir'] is None or b['verdict'] is None:
            raise CertError('方向块缺方向头注释')
    return blocks


# ---- 证书文本解析（纯注释面；严格前缀文法，未知行 = 具名失败） -------------------------------

RE_FILE = re.compile(r'^; ===== 文件:(.+) =====$')
RE_OBLIGATION = re.compile(r'^; ---- vc:([^:]+):(\d+) — 索引 (.*)\(scope: (body|loop)\)----$')
RE_DIR = re.compile(r'^; dir: (low|high)$')
RE_VERDICT = re.compile(r'^; verdict: (proven|refuted|unknown)$')
RE_USES_GOAL = re.compile(r'^; uses_goal: (true|false|n/a)$')
RE_VACUOUS = re.compile(r'^; vacuous: (true|false)$')
RE_REFS = re.compile(r'^; refs: (\d+)$')
RE_REF = re.compile(r'^; ref (\d+): #(\d+) d(\d) \| norm: (\{.*\} <= -?\d+) \| λ=(\d+)$')
RE_IDENTITY = re.compile(r'^; identity: Σc = (.*) \| ΣK = (-?\d+) \((.*)\)$')
RE_ROW = re.compile(r'^\{(.*)\} <= (-?\d+)$')
RE_COEFF = re.compile(r'^(\S+): (-?\d+)$')


def parse_row_text(body):
    """`{i: 1, len$buf: -1} <= -1` → ({'i': 1, 'len$buf': -1}, -1)。"""
    m = RE_ROW.match(body)
    if not m:
        raise CertError('norm 行形状不符:%s' % clip(body))
    coeffs = {}
    inner = m.group(1).strip()
    if inner != '':
        for part in inner.split(','):
            pm = RE_COEFF.match(part.strip())
            if not pm:
                raise CertError('norm 系数项形状不符:%s' % clip(part))
            name = pm.group(1)
            if name in coeffs:
                raise CertError('norm 行变量重复:%s' % name)
            coeffs[name] = int(pm.group(2))
    return coeffs, int(m.group(2))


def parse_cert(text):
    """→ [{file, vc, idx_text, scope, dirs: [...]}]；结构错误 = CertError。"""
    lines = text.split('\n')
    if not lines or lines[0] != CERT_HEAD:
        raise CertError('首行不是证书头(得到 %s)' % clip(lines[0] if lines else '(空文件)'))
    obligations = []
    cur_file = None
    cur_ob = None
    cur_dir = None
    zero_note = False
    for i in range(1, len(lines)):
        raw = lines[i]
        if raw == '':
            continue
        if not raw.startswith(';'):
            raise CertError('第 %d 行不是注释面(证书全部以 ; 起行):%s' % (i + 1, clip(raw)))
        if raw == ZERO_OBLIGATION_LINE:
            zero_note = True
            continue
        m = RE_FILE.match(raw)
        if m:
            cur_file = m.group(1)
            cur_ob = None
            cur_dir = None
            continue
        m = RE_OBLIGATION.match(raw)
        if m:
            cur_ob = {'file': cur_file, 'vc': 'vc:%s:%s' % (m.group(1), m.group(2)),
                      'idx_text': m.group(3), 'scope': m.group(4), 'dirs': []}
            obligations.append(cur_ob)
            cur_dir = None
            continue
        if raw.startswith(CERT_HEADER_PREFIXES):
            continue  # 六条头注（文件节之前；内容不解析）
        m = RE_DIR.match(raw)
        if m:
            if cur_ob is None:
                raise CertError('第 %d 行 dir 不在任何义务节内' % (i + 1))
            cur_dir = {'dir': m.group(1), 'verdict': None, 'uses_goal': None, 'vacuous': None,
                       'refs_count': None, 'refs': [], 'identity_k': None,
                       'identity_coeff': None, 'no_cert': None}
            cur_ob['dirs'].append(cur_dir)
            continue
        if cur_dir is None:
            raise CertError('第 %d 行不属于任何方向节:%s' % (i + 1, clip(raw)))
        m = RE_VERDICT.match(raw)
        if m:
            cur_dir['verdict'] = m.group(1)
            continue
        m = RE_USES_GOAL.match(raw)
        if m:
            cur_dir['uses_goal'] = None if m.group(1) == 'n/a' else (m.group(1) == 'true')
            continue
        m = RE_VACUOUS.match(raw)
        if m:
            cur_dir['vacuous'] = m.group(1) == 'true'
            continue
        m = RE_REFS.match(raw)
        if m:
            cur_dir['refs_count'] = int(m.group(1))
            continue
        m = RE_REF.match(raw)
        if m:
            try:
                coeffs, k = parse_row_text(m.group(4))
            except CertError as exc:
                raise CertError('第 %d 行 %s' % (i + 1, exc))
            cur_dir['refs'].append({'n': int(m.group(1)), 'ai': int(m.group(2)),
                                    'd': int(m.group(3)), 'declared': (coeffs, k),
                                    'lambda': int(m.group(5))})
            continue
        if raw.startswith('; identity: '):
            m = RE_IDENTITY.match(raw)
            if not m:
                raise CertError('第 %d 行 identity 形状不符:%s' % (i + 1, clip(raw)))
            cur_dir['identity_coeff'] = m.group(1)
            cur_dir['identity_k'] = int(m.group(2))
            continue
        if raw.startswith(NO_CERT_PREFIX):
            cur_dir['no_cert'] = raw[len(NO_CERT_PREFIX):]
            continue
        raise CertError('第 %d 行未识别:%s' % (i + 1, clip(raw)))
    if not obligations and not zero_note:
        raise CertError('证书没有任何义务节,也没有 "%s" 标记(空证书不伪装成有结论)' % ZERO_OBLIGATION_LINE)
    return obligations


# ---- 复核（§10.2 三条判据 + §10.1 结构） ----------------------------------------------------

def verify(obligations, blocks):
    """→ (errors, stats)。blocks = None 表示仅自洽模式。"""
    errors = []
    stats = {'obligations': 0, 'dirs': 0, 'cert_dirs': 0, 'named_no_cert': 0,
             'refs': 0, 'identities': 0}
    by_key = {}
    if blocks is not None:
        for b in blocks:
            key = (b['file'], b['vc'], b['dir'])
            if key in by_key:
                errors.append('%s|%s/%s: SMT 方向块重复(同一文件节内)' % key)
                continue
            by_key[key] = b
    seen = set()
    for ob in obligations:
        stats['obligations'] += 1
        file_name = ob['file']
        vc = ob['vc']
        if file_name is None:
            errors.append('%s: 义务节不在任何文件节内' % vc)
        if len(ob['dirs']) != 2:
            errors.append('%s|%s: 方向节数 %d ≠ 2(应为 low 在前、high 在后)'
                          % (file_name, vc, len(ob['dirs'])))
        for pos, d in enumerate(ob['dirs']):
            stats['dirs'] += 1
            tag = '%s|%s/%s' % (file_name, vc, d['dir'])
            if pos == 0 and d['dir'] != 'low':
                errors.append('%s: 第 1 个方向节应为 low(得到 %s)' % (tag, d['dir']))
            if pos == 1 and d['dir'] != 'high':
                errors.append('%s: 第 2 个方向节应为 high(得到 %s)' % (tag, d['dir']))
            key = (file_name, vc, d['dir'])
            if key in seen:
                errors.append('%s: 证书方向节重复' % tag)
            seen.add(key)
            block = by_key.get(key)
            if d['verdict'] is None:
                errors.append('%s: 缺 verdict 行' % tag)
                continue
            if block is not None and block['verdict'] != d['verdict']:
                errors.append('%s: 证书 verdict=%s 与 SMT 块注释 verdict=%s 不一致'
                              % (tag, d['verdict'], block['verdict']))
            if d['verdict'] != 'proven':
                # 非 proven：必须无引用，且"无证书"行必须属于登记集（不静默、不发明措辞）。
                if d['refs']:
                    errors.append('%s: 非 proven 方向必须无引用(实际 %d 条)' % (tag, len(d['refs'])))
                elif d['no_cert'] is None:
                    errors.append('%s: 非 proven 方向必须携带"无证书"具名行' % tag)
                elif d['no_cert'] not in NO_CERT_REASONS:
                    errors.append('%s: 未登记的无证书原因:%s' % (tag, clip(d['no_cert'])))
                else:
                    stats['named_no_cert'] += 1
                continue
            if d['no_cert'] is not None:
                # proven 但无证书：原因必须登记（不静默、不伪装成有结论）。
                if d['refs']:
                    errors.append('%s: 无证书方向不得携带引用行' % tag)
                elif d['no_cert'] not in NO_CERT_REASONS:
                    errors.append('%s: 未登记的无证书原因:%s' % (tag, clip(d['no_cert'])))
                else:
                    stats['named_no_cert'] += 1
                continue
            # ---- proven 且有证书：结构 ----------------------------------------------------
            stats['cert_dirs'] += 1
            if d['refs_count'] is None:
                errors.append('%s: 缺 refs: 计数行' % tag)
                continue
            if d['refs_count'] != len(d['refs']):
                errors.append('%s: refs 计数 %d ≠ 引用行数 %d'
                              % (tag, d['refs_count'], len(d['refs'])))
                continue
            if d['uses_goal'] is None or d['vacuous'] is None:
                errors.append('%s: proven 证书缺 uses_goal/vacuous 字段' % tag)
            prev_ai, prev_d = -1, -1
            for k, r in enumerate(d['refs']):
                if r['n'] != k + 1:
                    errors.append('%s: 引用序号不连续(ref %d 出现在第 %d 位)' % (tag, r['n'], k + 1))
                if r['ai'] < prev_ai or (r['ai'] == prev_ai and r['d'] < prev_d):
                    errors.append('%s: 引用未按假设采集序输出(#%d d%d)' % (tag, r['ai'], r['d']))
                prev_ai, prev_d = r['ai'], r['d']
                if r['ai'] < 1:
                    errors.append('%s: 引用断言序号必须 ≥ 1(得到 #%d)' % (tag, r['ai']))
                if r['d'] not in (0, 1):
                    errors.append('%s: 归一方向必须是 d0/d1(得到 d%d)' % (tag, r['d']))
                if r['lambda'] < 1:
                    errors.append('%s: λ 须为正整数(≥1;生产者恒 1——协议 §10.2 允许多重引用但'
                                  '当前不产出 λ>1,见 §10.2 末段)(得到 %d)' % (tag, r['lambda']))
            # ---- 判据：Σλc（逐变量）与 ΣλK ------------------------------------------------
            sum_c = {}
            sum_k = 0
            bad = False
            for r in d['refs']:
                if blocks is None:
                    row = r['declared']          # 仅自洽：只能信声明值
                else:
                    if block is None:
                        errors.append('%s: 找不到对应的 SMT 方向块(文件节/vc/方向对不上——'
                                      '两件工件不是同一次导出,或引用落在块外)' % tag)
                        bad = True
                        break
                    if r['ai'] < 1 or r['ai'] > len(block['asserts']):
                        errors.append('%s: 引用 #%d 越界(该方向块只有 %d 条断言——块外引用)'
                                      % (tag, r['ai'], len(block['asserts'])))
                        bad = True
                        continue
                    try:
                        rows = rows_of_predicate(sexp_parse(block['asserts'][r['ai'] - 1])[0])
                    except CertError as exc:
                        errors.append('%s: 断言 #%d 归一失败:%s' % (tag, r['ai'], exc))
                        bad = True
                        continue
                    if r['d'] >= len(rows):
                        errors.append('%s: 引用 #%d 的归一方向 d%d 越界(该断言有 %d 条归一)'
                                      % (tag, r['ai'], r['d'], len(rows)))
                        bad = True
                        continue
                    row = rows[r['d']]
                    declared_coeffs, declared_k = r['declared']
                    for name in sorted(set(row[0]) | set(declared_coeffs)):
                        dv = declared_coeffs.get(name, 0)
                        rv = row[0].get(name, 0)
                        if dv != rv:
                            errors.append('%s: 引用 #%d 声明系数 %s:%d ≠ 重算 %d(篡改系数)'
                                          % (tag, r['ai'], name, dv, rv))
                            bad = True
                    if declared_k != row[1]:
                        errors.append('%s: 引用 #%d 声明 K=%d ≠ 重算 K=%d(篡改常数项)'
                                      % (tag, r['ai'], declared_k, row[1]))
                        bad = True
                for name, val in row[0].items():
                    nv = sum_c.get(name, 0) + val * r['lambda']
                    if nv == 0:
                        sum_c.pop(name, None)
                    else:
                        sum_c[name] = nv
                sum_k += row[1] * r['lambda']
                stats['refs'] += 1
            if bad:
                continue
            if sum_c:
                detail = ', '.join('%s=%d' % (name, sum_c[name]) for name in sorted(sum_c))
                errors.append('%s: Σλc 在变量 %s 上非零(漏引用/引用不足)' % (tag, detail))
                continue
            if not sum_k < 0:
                errors.append('%s: ΣλK = %d ≥ 0(不构成不可满足证书)' % (tag, sum_k))
                continue
            # 自述 identity 行对照（写给人看的；复核必须以重算值为准）
            if d['identity_k'] is None:
                errors.append('%s: 缺 identity 行' % tag)
            elif d['identity_k'] != sum_k:
                errors.append('%s: 证书自述 ΣK=%d ≠ 重算 ΣK=%d' % (tag, d['identity_k'], sum_k))
            if d['identity_coeff'] != IDENTITY_COEFF_TEXT:
                errors.append('%s: 证书自述 Σc 形态异常:%s' % (tag, clip(d['identity_coeff'])))
            # uses_goal 的机械核验（仅对照模式有断言面；取反目标恒为块内末条）
            if block is not None and d['uses_goal'] is not None:
                expect = any(r['ai'] == len(block['asserts']) for r in d['refs'])
                if d['uses_goal'] != expect:
                    errors.append('%s: uses_goal=%s 与引用面不符(取反目标 = #%d;期望 %s)'
                                  % (tag, 'true' if d['uses_goal'] else 'false',
                                     len(block['asserts']), 'true' if expect else 'false'))
            stats['identities'] += 1
    # 反向覆盖：SMT 脚本里每个方向块都应有对应的证书方向节（证书侧不承诺覆盖未编码义务）。
    if blocks is not None:
        for b in blocks:
            if (b['file'], b['vc'], b['dir']) not in seen:
                errors.append('%s|%s/%s: SMT 方向块在证书里没有对应方向节(两件工件不是同一次导出?)'
                              % (b['file'], b['vc'], b['dir']))
    return errors, stats


# ---- 输出 -----------------------------------------------------------------------------------

def describe_dir(d):
    """方向节的单行摘要（确定性；只依赖证书声明面）。"""
    if d['verdict'] != 'proven':
        return d['verdict']
    if d['no_cert'] is not None:
        return 'proven(无证书:%s)' % d['no_cert']
    return 'proven(%d 引用%s)' % (len(d['refs']), ', uses_goal' if d['uses_goal'] else '')


def emit_report(cert_path, smt_path, obligations, errors, stats):
    out = []
    out.append('verify_cert — Ming 线性不可满足证书独立验证器(判据:docs/proof-protocol.md §10,第二语言实现)')
    out.append('证书:%s' % cert_path)
    if smt_path is None:
        out.append('SMT :(未提供)')
        out.append('模式:仅自洽——只校验证书声明行的内部恒等式;'
                   '系数篡改与引用序号越界(块外引用)无法发现')
    else:
        out.append('SMT :%s' % smt_path)
        out.append('模式:对照——按 §10.3 从 SMT 断言重算归一与 Σλc/ΣλK;不信任证书声明的系数')
    if not obligations:
        out.append('')
        out.append('(零证明义务:证书只有头注与 "; 无证明义务")')
    cur_file = object()
    for ob in obligations:
        if ob['file'] != cur_file:
            cur_file = ob['file']
            out.append('')
            out.append('[文件:%s]' % (cur_file if cur_file is not None else '(无文件节)'))
        out.append('  %s — 索引 %s(scope: %s)'
                   % (ob['vc'], ob['idx_text'], ob['scope']))
        for d in ob['dirs']:
            out.append('    %-4s %s' % (d['dir'] + ':', describe_dir(d)))
    out.append('')
    out.append('汇总:义务 %d · 方向 %d · 证书方向 %d · 具名无证书 %d · 引用 %d · 恒等式 %d'
               % (stats['obligations'], stats['dirs'], stats['cert_dirs'],
                  stats['named_no_cert'], stats['refs'], stats['identities']))
    if errors:
        out.append('结论:失败(%d 项)——明细见 stderr' % len(errors))
    elif smt_path is None:
        out.append('结论:通过 — 仅自洽,未与脚本对照(成立的是"证书自述恒等式自洽",'
                   '不是"编码后的约束集不可满足")')
    else:
        out.append('结论:通过 — 对照模式:引用系数、归一值、恒等式均由 SMT 脚本独立重算')
    out.append('边界:证书只证"该义务按本协议编码后的约束集在整数域不可满足";'
               '不证编码忠实于源码、不证运行时安全,不是程序正确性证明。')
    sys.stdout.write('\n'.join(out) + '\n')


def main(argv):
    cert_path = None
    smt_path = None
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ('--help', '-h'):
            sys.stdout.write(USAGE + '\n')
            return 0
        if arg == '--smt':
            i += 1
            if i >= len(argv):
                sys.stderr.write('[fail] --smt 需要一个路径(用法见 --help)\n')
                return 1
            if smt_path is not None:
                sys.stderr.write('[fail] --smt 重复给出(只对照一份脚本;第一个:%s,第二个:%s)\n'
                                 % (smt_path, argv[i]))
                return 1
            smt_path = argv[i]
        elif arg.startswith('--smt='):
            if smt_path is not None:
                sys.stderr.write('[fail] --smt 重复给出(只对照一份脚本;第一个:%s,第二个:%s)\n'
                                 % (smt_path, arg[len('--smt='):]))
                return 1
            smt_path = arg[len('--smt='):]
            if smt_path == '':
                sys.stderr.write('[fail] --smt= 的路径为空(用法见 --help)\n')
                return 1
        elif arg.startswith('-'):
            sys.stderr.write('[fail] 未知旗标:%s(用法见 --help)\n' % arg)
            return 1
        else:
            if cert_path is not None:
                sys.stderr.write('[fail] 只接受一个证书路径(第二个:%s)\n' % arg)
                return 1
            cert_path = arg
        i += 1
    if cert_path is None:
        sys.stderr.write('[fail] 缺少证书路径(用法见 --help)\n')
        return 1

    try:
        cert_text = read_text(cert_path, '证书')
        smt_text = read_text(smt_path, 'SMT 脚本') if smt_path is not None else None
    except CertError as exc:
        sys.stderr.write('[fail] %s\n' % exc)
        return 1
    try:
        obligations = parse_cert(cert_text)
    except CertError as exc:
        sys.stderr.write('[fail] 证书解析失败:%s\n' % exc)
        return 1
    blocks = None
    if smt_text is not None:
        try:
            blocks = parse_smt_blocks(smt_text)
        except CertError as exc:
            sys.stderr.write('[fail] SMT 脚本解析失败:%s\n' % exc)
            return 1
    errors, stats = verify(obligations, blocks)
    for err in errors:
        sys.stderr.write('[fail] %s\n' % err)
    emit_report(cert_path, smt_path, obligations, errors, stats)
    return 0 if not errors else 1


if __name__ == '__main__':
    configure_stdio()
    try:
        sys.exit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.exit(1)
    except (CertError, RecursionError, ValueError) as exc:
        # 纵深防御：输入校验的应有出口是 CertError（具名）；漏到这里的异常同样是
        # "输入未被完整校验"的证据——如实具名并 exit 1，不吐裸 traceback。
        sys.stderr.write('[fail] 输入未被完整校验(%s):%s(这是验证器的输入校验缺口,请报告)\n'
                         % (type(exc).__name__, exc))
        sys.exit(1)
