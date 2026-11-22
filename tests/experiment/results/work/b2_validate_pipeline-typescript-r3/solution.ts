// 数据校验管线：读取 JSON 记录数组，按固定 schema 逐字段校验（全字段检查、不短路），
// 输出逐记录结果行与末行汇总。用法：node solution.ts <记录文件路径>

import { readFileSync } from "node:fs";

type FieldName = "id" | "email" | "age" | "role";
type RecordObj = Record<string, unknown>;

// 字段检查顺序固定：id → email → age → role
const FIELD_ORDER: readonly FieldName[] = ["id", "email", "age", "role"];
const VALID_ROLES: readonly string[] = ["admin", "user", "guest"];

// 记录必须是非 null 对象（数组元素若不是对象，则视为所有字段缺失 → 全部无效）
function isRecordObj(v: unknown): v is RecordObj {
    return typeof v === "object" && v !== null;
}

// 单字段有效性：存在 + 类型 + 约束（值语义逐字按 schema）
function fieldValid(name: FieldName, rec: RecordObj): boolean {
    const val: unknown = rec[name];
    if (name === "id") {
        return typeof val === "number" && val >= 1;
    }
    if (name === "email") {
        return typeof val === "string" && val.includes("@");
    }
    if (name === "age") {
        return typeof val === "number" && val >= 0 && val <= 150;
    }
    // role：整串等值
    return typeof val === "string" && VALID_ROLES.includes(val);
}

// 一条记录的无效字段列表（按检查顺序；缺字段即无效）
function invalidFieldsOf(rec: unknown): string[] {
    const invalid: string[] = [];
    if (isRecordObj(rec)) {
        for (const name of FIELD_ORDER) {
            if (!fieldValid(name, rec)) {
                invalid.push(name);
            }
        }
    } else {
        for (const name of FIELD_ORDER) {
            invalid.push(name);
        }
    }
    return invalid;
}

function renderOutput(records: readonly unknown[]): string {
    const lines: string[] = [];
    let okCount = 0;
    let failedCount = 0;
    for (let i = 0; i < records.length; i += 1) {
        const seq: number = i + 1;
        const invalid: string[] = invalidFieldsOf(records[i]);
        if (invalid.length === 0) {
            okCount += 1;
            lines.push("record " + seq + " ok");
        } else {
            failedCount += 1;
            const parts: string[] = invalid.map((f: string) => f + " invalid");
            lines.push("record " + seq + " " + parts.join("; "));
        }
    }
    lines.push("ok=" + okCount + " failed=" + failedCount);
    return lines.join("\n") + "\n";
}

function run(): string {
    const arg: string | undefined = process.argv[2];
    if (arg === undefined) {
        throw new Error("missing argument: records file path");
    }
    let text: string;
    try {
        text = readFileSync(arg, "utf8");
    } catch {
        throw new Error("cannot read file: " + arg);
    }
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error("invalid JSON in " + arg);
    }
    if (!Array.isArray(parsed)) {
        throw new Error("top-level value is not a JSON array");
    }
    return renderOutput(parsed);
}

try {
    process.stdout.write(run());
} catch (e) {
    const msg: string = e instanceof Error ? e.message : String(e);
    process.stderr.write("error: " + msg + "\n");
    process.exit(1);
}
