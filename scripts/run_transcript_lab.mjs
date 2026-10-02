import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const children = [];
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
let stopping = false;

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    process.stderr.write(`${name} could not start: ${error.message}\n`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `${name} stopped unexpectedly${signal ? ` (${signal})` : ` (exit ${code ?? "unknown"})`}.\n`,
    );
    stop(code && code !== 0 ? code : 1);
  });
  return child;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

process.on("SIGINT", () => {
  stop(0);
});
process.on("SIGTERM", () => {
  stop(0);
});

start("Transcript service", process.execPath, ["transcript-service/server.mjs"]);
start("Local UI", process.execPath, [
  "node_modules/vite/bin/vite.js",
  "--host",
  "127.0.0.1",
  "--strictPort",
]);
