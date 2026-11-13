# ADR-002 Spike:12 工具迁移验证(v0.61 启动门槛②)

> **状态**:完成——**门槛②满足** · **日期**:2026-11-14 · **基线**:HEAD 52617ae(v0.60.0,905 项回归全绿)
> **方法**:只读代码 + 读文档(12 个 `tools/*.ming` 全文通读 + 全仓 `env.get`/`read_line`/`extern` 扫描,含 examples/GUIDE/tests);本 spike 只写本文件与 `docs/plan.md` §4.4.5 状态回填,未改任何代码与工具。
> **裁决依据**:docs/adr-002-taint.md §3.1 修订块(v1 窄源:只标 `std.env.get`、`std.io.read_line`、extern 返回强制)与 §3.4 的 2026-11-14 裁决(`sanitize_cli_path`:校验不改写,拒绝 NUL/C0 控制字符,Ok 原样返回;授权位 = 路径实参位)。argv 在 v1 **不标**(plan §4.4.5"无 argv 载体")。
> **口径说明**:本报告的"迁移调用点"以 **`env.get` 解包位**计(每个调用点 = 一处 `Some(v)` 分支包一层 `sanitize_cli_path(v)` + 显式 Err 处理);净化在来源边界完成,下游路径 sink 与内容处理零改动。

---

## 1. 结论(先行)

| 判据 | 结果 |
|------|------|
| 12 工具内容处理逻辑改动 | **0 处**(12/12 零改动;五个重点工具逐一确认见 §4) |
| 迁移调用点总数 | **12 处**(全部为 `env.get` 解包位;落在估计区间 12–20 的下限) |
| 其中路径实参位(`sanitize_cli_path` 授权位内) | **8 处**(wc/tree/find_files/json_query/todo_scan/log_analyzer/batch_rename/file_organizer 各自的目录/文件回退变量) |
| 其中非路径位(需一次授权位登记或等价改道) | **4 处**(find_files FIND_NAME、json_query JSON_FIELD、batch_rename RENAME_PREFIX/RENAME_EXT;见 §6) |
| v1 来源在工具中的实际分布 | `env.get` ×12;`read_line` ×0;`extern` ×0;argv 直收 ×8 工具带 env 回退(另 4 工具纯 argv,亦零迁移) |
| 9 源全量对照 | 断点覆盖 **8/12 工具**(ADR-002 §3.1 实测点名 5 个,静态读码补充 3 个,见 §5);窄源 v1 断点 **0** |

**判定:门槛②满足**——没有任何工具需要改内容处理逻辑;迁移面全部是"env 回退变量在解包位包一层净化"的机械改动,每点约 +4–6 行(12 点合计约 50–70 行,含显式 Err 分支)。不触发 plan §4.4.5 的退化路径。

---

## 2. 逐工具表

| 工具 | v1 来源调用 | 路径 sink 调用点(env 值流向) | 内容处理(read_file/exec 输出) | 迁移动作 |
|------|------------|------------------------------|------------------------------|----------|
| mingkit | 无(`read_to_end` 非 v1 来源,mk:151) | 无——文件实参全部 argv 直收 | read_file → split/print/print_raw/write_file content:**零改动** | **零改动** |
| edit | 无 | 无——argv 直收(`load(file)`) | read_file → split/行编辑/join_lines/write_file content:**零改动** | **零改动** |
| engdiff | 无 | 无——exec 实参 = 常量 + argv | exec stdout 对比/打印(stdout 不标):**零改动** | **零改动** |
| diaghot | 无 | 无——argv 直收(`expand`) | exec stdout → `json.parse`(stdout 不标):**零改动** | **零改动** |
| wc | `env.get` ×1(:45 WC_FILE) | `read_file(path)`(经 count_file) | read_file → split/trim/re.split/byte_len:**零改动** | 1 调用点:sanitize_cli_path |
| tree | `env.get` ×1(:72 TREE_ROOT) | `list_dir(dir)`/`is_dir(full)`(经 print_tree) | 无 read_file | 1 调用点:sanitize_cli_path |
| find_files | `env.get` ×2(:54 FIND_ROOT,:63 FIND_NAME) | `list_dir(dir)`/`is_dir(full)`(FIND_ROOT) | 无 read_file;FIND_NAME 是匹配串(`contains`) | 2 调用点:1 路径位 + 1 非路径位(§6) |
| json_query | `env.get` ×2(:78 JSON_FILE,:87 JSON_FIELD) | `read_file(path)`(JSON_FILE) | read_file → `json.parse` → 下钻/输出:**零改动** | 2 调用点:1 路径位 + 1 非路径位(§6) |
| todo_scan | `env.get` ×1(:94 TODO_SCAN_ROOT) | `list_dir`/`is_dir`/`read_file`(均经 root 派生) | read_file → split/re.is_match/print:**零改动** | 1 调用点:sanitize_cli_path |
| log_analyzer | `env.get` ×1(:59 LOG_FILE) | `read_file(path)` | read_file → split/contains/分类计数:**零改动** | 1 调用点:sanitize_cli_path |
| batch_rename | `env.get` ×3(:70/:79/:88) | `list_dir(dir)`/`rename(old, new)`;RENAME_PREFIX 经拼接进 new_path | 无 read_file;starts_with/拼接/`!=` 过滤 | 3 调用点:1 路径位 + 2 非路径位(§6) |
| file_organizer | `env.get` ×1(:69 ORGANIZE_ROOT) | `list_dir(dir)`/`make_dir(target_dir)`/`rename(full, target)` | 无 read_file | 1 调用点:sanitize_cli_path |

工具代码行号前缀:mk = mingkit,ed = edit,edg = engdiff,dh = diaghot,jq = json_query,ts = todo_scan,la = log_analyzer;wc/tree/find_files/batch_rename/file_organizer 用文件名。路径 sink 家族按 ADR-002 §3.4 授权位(read_file/write_file/append_file/make_dir/remove_file/remove_dir_recursive/metadata/copy_file/rename 及同族 list_dir/is_dir 的 path 形参)。

---

## 3. 迁移调用点总清单(12 处)

每处迁移形态一致:`Some(v)` 分支内 `match std.unstr.sanitize_cli_path(v) { Ok(p) => <原赋值/入列>, Err(e) => eprint + 退出 1 }`(错误显式化,与工具既有错误纪律一致;Err 不静默吞,不用 `unwrap_or("")`)。

| # | 文件:行 | env 变量 | 现行代码(关键行) | 流向与 sink | 授权位 |
|---|---------|----------|-------------------|-------------|--------|
| 1 | tools/wc.ming:45-47 | WC_FILE | `match std.env.get("WC_FILE") { Some(v) => { files.push(v); }` | `files` → `count_file(f)` → `std.fs.read_file(path)`(wc.ming:15)路径实参 | 路径位 |
| 2 | tools/tree.ming:72-74 | TREE_ROOT | `match std.env.get("TREE_ROOT") { Some(v) => { root = v; }` | `root` → `print_tree(root,…)`(:81)→ `std.fs.list_dir(dir)`(:18)/`is_dir(full)`(:29);另 `print(root)`(:80) | 路径位 |
| 3 | tools/find_files.ming:54-56 | FIND_ROOT | `match std.env.get("FIND_ROOT") { Some(v) => { root = v; }` | `root` → `find(root,…)`(:76)→ `std.fs.list_dir(dir)`(:14)/`is_dir(full)`(:18);另插值 `print`(find_files.ming:75) | 路径位 |
| 4 | tools/find_files.ming:63-65 | FIND_NAME | `match std.env.get("FIND_NAME") { Some(v) => { needle = v; }` | `needle` → `name.contains(needle)`(:29);插值 `print`(:75)。**非路径实参** | 非路径位(§6) |
| 5 | tools/json_query.ming:78-80 | JSON_FILE | `match std.env.get("JSON_FILE") { Some(v) => { path = v; }` | `path` → `std.fs.read_file(path)`(json_query.ming:100)路径实参 | 路径位 |
| 6 | tools/json_query.ming:87-89 | JSON_FIELD | `match std.env.get("JSON_FIELD") { Some(v) => { first_field = v; }` | `first_field` → **仅判空**(:95 `if path == "" \|\| first_field == ""`);值不被任何查询消费 | 非路径位(§6) |
| 7 | tools/todo_scan.ming:94-96 | TODO_SCAN_ROOT | `match std.env.get("TODO_SCAN_ROOT") { Some(v) => { root = v; }` | `root` → 插值 `print`(:102)+ `scan_dir(root)`(:103)→ `list_dir`(:28)/`is_dir`(:32)/`scan_file` → `read_file(path)`(:64) | 路径位 |
| 8 | tools/log_analyzer.ming:59-61 | LOG_FILE | `match std.env.get("LOG_FILE") { Some(v) => { path = v; }` | `path` → `analyze(path)`(:71)→ `std.fs.read_file(path)`(:12);另插值 `print`(:38) | 路径位 |
| 9 | tools/batch_rename.ming:70-72 | RENAME_DIR | `match std.env.get("RENAME_DIR") { Some(v) => { dir = v; }` | `dir` → `batch_rename(dir,…)`(:103)→ `list_dir(dir)`(:15)/`is_dir`(:18)/`rename(old_path, new_path)`(:33) | 路径位 |
| 10 | tools/batch_rename.ming:79-81 | RENAME_PREFIX | `match std.env.get("RENAME_PREFIX") { Some(v) => { prefix = v; }` | `prefix` → `name.starts_with(prefix)`(:23)/`prefix + name`(:30)→ `path.join(dir, new_name)`(:32)→ `rename`(:33) 的路径组成;插值 `print`(:102)。**经拼接进入路径目的地** | 路径目的地(登记注明,§6) |
| 11 | tools/batch_rename.ming:88-90 | RENAME_EXT | `match std.env.get("RENAME_EXT") { Some(v) => { ext = v; }` | `ext` → `file_ext != ext` 过滤比较(:27);插值 `print`(:102)。**非路径实参,不进任何 sink** | 非路径位(§6) |
| 12 | tools/file_organizer.ming:69-71 | ORGANIZE_ROOT | `match std.env.get("ORGANIZE_ROOT") { Some(v) => { root = v; }` | `root` → `organize(root,…)`(:84)→ `list_dir(dir)`(:15)/`make_dir(target_dir)`(:32)/`rename(full, target)`(:40) | 路径位 |

**全仓核对(工具之外的 v1 来源调用面)**:

- `examples/*.ming`(18 个):`env.get`/`read_line`/`extern` **0 处**——示例零迁移。
- `GUIDE.md`:代码示例 **0 处**;文档锚点 2 个(`§18 std.io` 的 `read_line() -> str` 签名行、std.env 修订记录文字)——属 v0.61 任务 4 的文档同步,不是调用点。
- `tests/run.mjs`:`io.read_line()` 1 处(v64.B4 计费用例),结果仅调 `byte_len()`——**白名单方法,零迁移**;`extern "msvcrt" fn` **3 个不同签名**(`_abs64`/`strlen`/`memchr`;声明文本出现 5 处)全部返回 `i64`/`Ptr[u8]`(数值/指针非污点载体),不受 extern 返回强制标污影响——零迁移。
- 其余 `.ming` 命中均为 `.zcode/` 会话工件副本,不入库不计。

**结论:全仓 v1 迁移面 = 工具 12 处**,即 ADR-002 §6.1 估计"12–20 处调用点"的下限,无隐藏面。

---

## 4. 五个重点工具的内容处理确认(门槛②的原始命题)

门槛②的原始表述:"`mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 在窄源方案下不改内容处理逻辑"。逐一确认:

1. **mingkit**(359 行):内容来源只有 `std.fs.read_file` ×5(mk:83/169/218/264/337)与 `std.io.read_to_end`(mk:151)。两者在 v1 **均不标**(窄源只标 `read_line`,不标 `read_to_end`;`read_file` 不标)。内容流 `split`(mk:118/182/228/292/345)、`esc`/`join_lines`、`print`/`print_raw`(mk:123/139/141)、`write_file`/`append_file` 的 content 位(mk:152/202/248/321)全部不受污点约束。**零改动**。
2. **json_query**(118 行):`read_file`(jq:100)→ `json.parse`(jq:101)→ Json 下钻/`show`/`print`/`debug`。`read_file` 不标 → `json.parse(str)` 形参合法。**内容处理零改动**;仅 2 个 env 回退变量需净化(§3 #5/#6)。
3. **diaghot**(267 行):`proc.exec` stdout(dh:173)→ `json.parse`(dh:174)→ 聚合/`print`。stdout 在 v1 **不标**。argv 路径经 `expand` 进 `list_dir`/`is_dir`,argv 不标。**零改动**。
4. **log_analyzer**(72 行):`read_file`(la:12)→ `split`(la:14)→ `contains` 分类(la:28-31)→ `print`(la:38-43)。`read_file` 不标。**内容处理零改动**;仅 LOG_FILE 回退需净化(§3 #8)。
5. **edit**(296 行):`read_file`(ed:63,`load`)→ `split`(ed:65)→ 行编辑/`join_lines` → `write_file` content(ed:79 经 save)。`read_file` 不标。**零改动**。

**五个重点工具全部确认**:3 个整体零改动(mingkit/diaghot/edit),2 个仅有 env 回退变量的解包位净化(json_query ×2、log_analyzer ×1),内容处理逻辑无一处触及。

---

## 5. 9 源全量对照(为什么窄源可行)

ADR-002 §3.1 修订注已实测:"9 源全量会让 `mingkit`/`json_query`/`diaghot`/`log_analyzer`/`edit` 五个自写工具直接 M3002(实测)"。本 spike 静态读码给出精确断点行号(不复跑,引用 ADR 实测结论),并补充 ADR 未点名的 3 个:

| 工具 | 9 源全量下的首个断点(静态定位) |
|------|------------------------------|
| mingkit | `read_file` ×5 → `split`(mk:118 等)/`print`(mk:123 等)/`write_file` content(mk:202 等);`read_to_end`(mk:151)→ write_file content(mk:152) |
| edit | `read_file`(ed:63)→ `split`(ed:65)→ 行数组全链 → `write_file` content(ed:79) |
| engdiff | `proc.exec` stdout(edg:23)→ 结果对比(edg:70)/`print`(edg:78)——**ADR 未点名,静态补充** |
| diaghot | `proc.exec` stdout(dh:173)→ `json.parse`(dh:174) |
| wc | `read_file`(wc:15)→ `split`/`trim`/`re.split`(wc:17/25/28)——**ADR 未点名,静态补充** |
| json_query | `read_file`(jq:100)→ `json.parse`(jq:101) |
| todo_scan | `read_file`(ts:64)→ `split`(ts:66)/`re.is_match`(ts:71)——**ADR 未点名,静态补充** |
| log_analyzer | `read_file`(la:12)→ `split`(la:14)/`contains`(la:28-31)/`print`(la:38-43) |

tree/find_files/batch_rename/file_organizer 无 `read_file`/`read_to_end`/`exec`,9 源全量下不断点(list_dir 条目与 argv 不在任何来源表)。**汇总:9 源全量断点 8/12 工具;窄源 v1 断点 0/12。** 这正是窄源裁决的量化依据:fs/net/proc 内容源不标,工具的内容处理链(占 12 工具中 8 个的核心逻辑)整体移出迁移面。

---

## 6. 风险与备注

1. **4 处非路径位的授权位问题(spike 的唯一方案外发现,非阻塞)**。ADR-002 §3.4 的 2026-11-14 裁决将 `sanitize_cli_path` 授权位定为"路径实参位(含 CLI 工具把 `env.get` 结果传给 wc/tree/find_files 类路径形参)"。12 处调用点中 8 处直接命中;4 处 env 值的用途不是路径实参:
   - **RENAME_PREFIX**(§3 #10):经 `prefix + name` 拼接后进入 `rename` 的 path 实参组成——可归"路径目的地",在授权位精神内,实现时登记注明即可。
   - **FIND_NAME**(§3 #4)、**RENAME_EXT**(§3 #11):纯匹配/比较串(`contains`/`!=`),不进任何 sink;**JSON_FIELD**(§3 #6):仅判空,值不被消费。
   - 处置(已裁决,2026-11-14 选项 a):**一次授权位登记**——`sanitize_cli_path` 的授权位明确扩及"CLI 提供的匹配/比较串"——其校验不改写语义(拒 NUL/C0,Ok 原样返回)本就是任意 CLI 字符串的正确净化;不新增函数、不新增语言面,按族扩展纪律登记一次扩权 + 测试向量锁定。改动 = 3 个调用点各包一层 + GUIDE 一行授权位文字 + 测试向量(**ADR-002 §3.4 扩权登记已于 2026-11-14 裁决时完成**)。
   - 无论选哪条,均**不改任何工具的内容处理逻辑**,不影响本判定。
2. **argv 口径**:v1 不标 argv(plan §4.4.5 明确"无 argv 载体",本任务口径同),8 个工具的 argv 路径直收零迁移。ADR-002 §3.4"否决选项②(argv 不标)"是**绝对路径/CLI 策略**裁决(否决的是"以永久豁免 argv 来回答 CLI 路径问题",为 v1.1+ 扩面预留 `sanitize_cli_path` 这一正确出口),与"v1 载体清单无 argv"不冲突;两处文字并存如实登记,实现时以 plan §4.4.5 载体清单为准。
3. **Err 语义纪律**:12 处迁移的 `Err` 分支应显式 `eprint` 变量名与原因并退出 1(工具既有错误纪律),不用 `unwrap_or("")` 静默吞——与 ADR-002 §3.4 失败语义一致。净化后行为变化:含 NUL/C0 控制字符的 env 值从"照单全收"变为"报错退出 1",属净化器的既定语义收紧,良性值行为逐字不变。
4. **估计对照**:ADR-002 §6.1"12–20 处调用点"覆盖全仓(工具 + 测试 + 示例);实测全仓 = 12 处,全部落在工具层,机械且面窄,无方案外阻塞。
