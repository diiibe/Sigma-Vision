import net from "node:net";
import { spawn } from "node:child_process";

const cwd = process.cwd();
const children = [];
let shuttingDown = false;
const freshStateDir = process.env.HACK26_STATE_DIR || "backend/state/dev-blank";

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      HACK26_STATE_DIR: freshStateDir,
    },
    stdio: "inherit",
    shell: false,
  });

  child.on("exit", (code) => {
    if (shuttingDown) {
      return;
    }
    if (code !== 0) {
      process.exitCode = code ?? 1;
    }
    shutdown();
  });

  children.push(child);
  console.log(`[demo] started ${name}`);
}

function shutdown() {
  shuttingDown = true;
  while (children.length > 0) {
    const child = children.pop();
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

function isPortBusy(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function canReuseApi() {
  if (!(await isPortBusy(8000))) {
    return false;
  }

  try {
    const response = await fetch("http://127.0.0.1:8000/api/live/snapshot");
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[demo] using state dir ${freshStateDir}`);
  const reuseApi = await canReuseApi();
  if (reuseApi) {
    console.log("[demo] reusing existing api on http://127.0.0.1:8000");
  } else {
    start("api", "python3", ["-m", "uvicorn", "backend.app:app",
      "--reload",
      "--reload-include", "*.py",
      "--port", "8000"]);
  }

  start("ui", "npm", ["run", "dev:ui"]);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main().catch((error) => {
  console.error("[demo] failed to start", error);
  process.exitCode = 1;
  shutdown();
});
