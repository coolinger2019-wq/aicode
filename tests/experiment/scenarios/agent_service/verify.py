# S4 黑盒验收(Python):原生管理同语言服务生命周期——启动(端口漂移)/就绪轮询/
# 顺序 23 case + 并发 8×20 请求(8 线程、客户端内按序、按客户端序聚合)/关停,
# transcript 与 expected 逐字节比对 + 参数级腿(端口 0/65536/非数字)+ 端口被占腿 +
# 负例腿(交叉喂入 B4 参考实现预期 FAIL/expected 变异样本预期 mismatch)。
# R19 超大体 = 头-only 声明尺寸请求(GAP-S4-1,与 harness.mjs 同形)。
# 用法(从仓库根):python tests/experiment/scenarios/agent_service/verify.py [被测程序路径]
import http.client
import json
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

TASK_DIR = Path(__file__).resolve().parent
REPO_ROOT = TASK_DIR.parents[3]
BASE = "tests/experiment/scenarios/agent_service"
BASE_PORT = 21531


def load_cases():
    with open(REPO_ROOT / BASE / "input" / "requests.json", "r", encoding="utf-8", newline="") as f:
        return json.load(f)["cases"]


def load_conc():
    with open(REPO_ROOT / BASE / "input" / "concurrency.json", "r", encoding="utf-8", newline="") as f:
        return json.load(f)


def load_expected():
    with open(REPO_ROOT / BASE / "expected" / "expected_transcript.txt", "r", encoding="utf-8", newline="") as f:
        return f.read()


def payload_of(desc, status, body):
    if status is None:
        return "ERR %s" % body
    if desc.get("normalize"):
        try:
            code = json.loads(body).get("code") or "?"
        except ValueError:
            code = "?"
        return "code=%s" % code
    return body


def send(port, desc):
    # 每请求新建连接(HTTP/1.0 服务端逐请求关连接;无跨请求连接状态)
    try:
        if desc.get("body_size"):
            # 头-only 声明尺寸请求:显式 Content-Length、不发送体字节(GAP-S4-1)
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
            conn.putrequest("POST", desc["path"])
            conn.putheader("Content-Length", str(desc["body_size"]))
            conn.endheaders()
            resp = conn.getresponse()
            body = resp.read().decode("utf-8", "replace")
            status = resp.status
            conn.close()
            return status, body
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        method = desc["method"]
        headers = None
        body = desc.get("body") or ""
        if method == "GET" or body == "":
            body = None
        else:
            # 显式 UTF-8 字节发送(http.client 对 str 体按 latin-1 编码,非 ASCII
            # 内容会与 Content-Length 失配导致服务端读挂)
            body = body.encode("utf-8")
            headers = {"Content-Length": str(len(body))}
        conn.request(method, desc["path"], body=body, headers=headers or {})
        resp = conn.getresponse()
        text = resp.read().decode("utf-8", "replace")
        status = resp.status
        conn.close()
        return status, text
    except (OSError, http.client.HTTPException) as e:
        return None, "%s" % (getattr(e, "errno", None) or e)


def start_service(cmd_prefix):
    # 端口漂移 base+7i ≤10;就绪 = GET /health 200;连续 5 次 HTTP 非 200 → 错服务
    for i in range(10):
        port = BASE_PORT + i * 7
        proc = subprocess.Popen(
            [*cmd_prefix, str(port)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        up = False
        wrong = 0
        deadline = time.time() + 15.0
        while time.time() < deadline:
            time.sleep(0.15)
            if proc.poll() is not None:
                break
            try:
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                conn.request("GET", "/health")
                resp = conn.getresponse()
                resp.read()
                conn.close()
                if resp.status == 200:
                    up = True
                    break
                wrong += 1
                if wrong >= 5:
                    break
            except (OSError, http.client.HTTPException):
                pass
        if up:
            return proc, port
        proc.kill()
        proc.wait()
        if wrong >= 5:
            return None, "wrong-service"
    return None, "no-start"


def run_phases(port, cases, conc):
    seq_lines = []
    for c in cases:
        status, body = send(port, c)
        seq_lines.append("%s -> %s %s" % (c["id"], status, payload_of(c, status, body)))
    per_client = [[None] * conc["per_client"] for _ in range(conc["clients"])]

    def client_loop(ci):
        client = ci + 1
        for j in range(1, conc["per_client"] + 1):
            pat = conc["pattern"][(j - 1) % len(conc["pattern"])]
            desc = {
                "method": pat["method"],
                "path": pat["path"],
                "body": (pat.get("body") or "").replace("<c>", str(client)),
            }
            status, body = send(port, desc)
            per_client[ci][j - 1] = "C%dR%d -> %s %s" % (client, j, status, payload_of(pat, status, body))

    threads = [threading.Thread(target=client_loop, args=(ci,)) for ci in range(conc["clients"])]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    conc_lines = []
    for block in per_client:
        conc_lines.extend(block)
    return "\n".join(seq_lines + conc_lines) + "\n"


def transcript_of(cmd_prefix, cases, conc):
    proc, port_or_err = start_service(cmd_prefix)
    if proc is None:
        return None, port_or_err
    try:
        transcript = run_phases(port_or_err, cases, conc)
    finally:
        proc.kill()  # 异常路径也必须关停,防长驻服务泄漏占用漂移端口
        proc.wait()
    return transcript, None


def is_single_line_stderr(s):
    # stderr 恰一行(spec §4 字面):恰一个换行且在末尾(universal newlines 已归一 \r\n)
    return (s or "").count("\n") == 1 and s.endswith("\n")


def expect_param_error(tag, prog, arg):
    r = subprocess.run(
        [sys.executable, str(prog), arg],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    if r.returncode != 1:
        print("FAIL %s: exit=%d(预期 1)\n%s" % (tag, r.returncode, r.stderr or ""), file=sys.stderr)
        return 1
    if r.stdout != "":
        print("FAIL %s: stdout 非空(预期空)" % tag, file=sys.stderr)
        return 1
    if not (r.stderr or "").startswith("error:"):
        print("FAIL %s: stderr 未以 error: 开头" % tag, file=sys.stderr)
        return 1
    if not is_single_line_stderr(r.stderr):
        print("FAIL %s: stderr 非恰一行" % tag, file=sys.stderr)
        return 1
    return 0


def expect_occupied(tag, prog):
    # 端口被占腿:持住漂移段第一个可绑定端口 → 起服务 → 绑定失败 exit 1 + stderr error:
    for i in range(10):
        port = BASE_PORT + i * 7
        holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            holder.bind(("127.0.0.1", port))
        except OSError:
            holder.close()
            continue
        holder.listen(5)
        try:
            r = subprocess.run(
                [sys.executable, str(prog), str(port)],
                cwd=str(REPO_ROOT),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=60,
            )
        finally:
            holder.close()
        if r.returncode != 1:
            print("FAIL %s: exit=%d(预期 1)" % (tag, r.returncode), file=sys.stderr)
            return 1
        if not (r.stderr or "").startswith("error:"):
            print("FAIL %s: stderr 未以 error: 开头" % tag, file=sys.stderr)
            return 1
        if not is_single_line_stderr(r.stderr):
            print("FAIL %s: stderr 非恰一行" % tag, file=sys.stderr)
            return 1
        return 0
    print("FAIL %s: 无可绑定端口" % tag, file=sys.stderr)
    return 1


def main():
    prog = Path(sys.argv[1]) if len(sys.argv) > 1 else TASK_DIR / "solutions" / "solution.py"
    cases = load_cases()
    conc = load_conc()
    expected = load_expected()

    # 腿 1:transcript(顺序 + 并发)逐字节
    transcript, err = transcript_of([sys.executable, str(prog)], cases, conc)
    if err:
        print("FAIL transcript 腿: %s" % err, file=sys.stderr)
        return 1
    if transcript != expected:
        print(
            "FAIL transcript 腿 mismatch actual_len=%d expected_len=%d" % (len(transcript), len(expected)),
            file=sys.stderr,
        )
        return 1

    # 腿 2–4:参数级(端口 0/65536/非数字)
    if expect_param_error("参数-端口0", prog, "0") != 0:
        return 1
    if expect_param_error("参数-端口65536", prog, "65536") != 0:
        return 1
    if expect_param_error("参数-端口非数字", prog, "abc") != 0:
        return 1

    # 腿 5:端口被占
    if expect_occupied("参数-端口被占", prog) != 0:
        return 1

    # 腿 6:负例-交叉喂入 B4 参考实现(路由不同 → 错服务)→ 必须按具体 FAIL 形态失败:
    # wrong-service(排除 no-start 静默通过,审查 MINOR-3 收口)
    b4 = REPO_ROOT / "tests/experiment/tasks/b4_serve_handler/solutions/solution.py"
    cross, cross_err = transcript_of([sys.executable, str(b4)], cases, conc)
    if cross_err != "wrong-service":
        if cross is not None and cross == expected:
            print("FAIL 负例-交叉喂入: B4 参考实现竟通过 S4 验收", file=sys.stderr)
        else:
            print("FAIL 负例-交叉喂入: 未按错服务形态失败(%s)" % cross_err, file=sys.stderr)
        return 1

    # 腿 7:负例-expected 变异样本(改一处标签)→ mismatch FAIL(逐字节比对有齿,S3 惯例)
    transcript2, err2 = transcript_of([sys.executable, str(prog)], cases, conc)
    if err2:
        print("FAIL 负例-变异样本: %s" % err2, file=sys.stderr)
        return 1
    mutated = expected.replace("code=handler_panic", "code=handler_panicX")
    if transcript2 != mutated:
        print("PASS")
        return 0
    print("FAIL 负例-变异样本: 变异期望竟与 transcript 一致(比对无齿)", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
