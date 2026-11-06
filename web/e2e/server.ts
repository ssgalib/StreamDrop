import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { resolve } from "node:path";

const serverDir = resolve(import.meta.dirname, "../../server");
const bin = resolve(import.meta.dirname, ".bin/streamdrop");
let proc: ChildProcess | undefined;

const portOpen = () =>
  new Promise<boolean>((done) => {
    const s = createConnection(8080, "127.0.0.1");
    s.on("connect", () => (s.destroy(), done(true)));
    s.on("error", () => done(false));
  });

// Tests start and stop their own server so they can restart it mid-transfer.
export async function startServer(env: Record<string, string> = {}) {
  if (!proc) execFileSync("go", ["build", "-o", bin, "."], { cwd: serverDir });
  if (await portOpen()) throw new Error("port 8080 is in use: stop the dev server before running e2e tests");
  proc = spawn(bin, ["-addr", "127.0.0.1:8080"], { stdio: "ignore", env: { ...process.env, ...env } });
  for (let i = 0; i < 50 && !(await portOpen()); i++) await new Promise((r) => setTimeout(r, 100));
}

export async function stopServer() {
  const p = proc;
  proc = undefined;
  if (!p) return;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill();
  await exited;
}
