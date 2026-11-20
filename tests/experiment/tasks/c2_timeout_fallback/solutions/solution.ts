// C2 超时与降级 — 参考实现(TypeScript + Node 24,Promise.race)
function child(ms: number): Promise<number> {
  return new Promise((res) => setTimeout(() => res(99), ms));
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((res) => setTimeout(() => res("timeout"), ms));
}

async function main(): Promise<void> {
  const slow = await Promise.race([child(400), timeout(100)]);
  if (slow === "timeout") {
    console.log("slow_child=timeout fallback=0");
  } else {
    console.log("slow_child=" + slow);
  }
  const fast = await Promise.race([child(50), timeout(2000)]);
  if (fast === "timeout") {
    console.log("fast_child=timeout fallback=0");
  } else {
    console.log("fast_child=" + fast);
  }
  process.exitCode = 0;
}

void main();
