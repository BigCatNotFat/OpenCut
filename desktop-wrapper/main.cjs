const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 3210;
const APP_URL = `http://${HOST}:${PORT}`;
const AI_BACKEND_URL = "http://127.0.0.1:7860";
const AI_STATUS_URL = `${AI_BACKEND_URL}/api/status`;

let mainWindow = null;
let serverProcess = null;
let aiBackendProcess = null;
let aiBackendStartedByApp = false;
let isQuitting = false;

app.setName("OpenCut Classic");

function appendLog(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "server.log");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Logging must never prevent the app from starting.
  }
}

function getOrCreateAuthSecret() {
  const secretPath = path.join(app.getPath("userData"), "auth-secret.txt");
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, "utf8").trim();
      if (existing.length >= 32) return existing;
    }

    const generated = crypto.randomBytes(48).toString("base64url");
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, generated, "utf8");
    return generated;
  } catch {
    return crypto.randomBytes(48).toString("base64url");
  }
}

function findAiBackendDirectory() {
  const candidates = [
    process.env.OPENCUT_AI_HOME,
    process.env.QWEN_ASR_HOME,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Desktop", "codex", "ai-studio-web")
      : null,
    path.resolve(__dirname, "..", "ai-studio-web"),
    app.isPackaged ? path.join(process.resourcesPath, "ai-studio-web") : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const pythonPath = path.join(candidate, ".venv", "Scripts", "python.exe");
    const appPath = path.join(candidate, "app.py");
    if (fs.existsSync(pythonPath) && fs.existsSync(appPath)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

async function isAiBackendReady(timeoutMs = 2500) {
  try {
    const response = await fetch(AI_STATUS_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const status = await response.json();
    return Boolean(status?.capabilities?.subtitle_timestamps);
  } catch {
    return false;
  }
}

async function waitForAiBackend(timeoutMs = 90000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isAiBackendReady(1500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

async function ensureAiBackend() {
  if (await isAiBackendReady()) {
    appendLog(`Reusing compatible local AI backend at ${AI_BACKEND_URL}`);
    return true;
  }

  const backendDirectory = findAiBackendDirectory();
  if (!backendDirectory) {
    appendLog("Local AI backend directory was not found; automatic captions remain unavailable.");
    return false;
  }

  const pythonPath = path.join(backendDirectory, ".venv", "Scripts", "python.exe");
  appendLog(`Starting local AI backend from ${backendDirectory}`);
  aiBackendProcess = spawn(
    pythonPath,
    ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "7860"],
    {
      cwd: backendDirectory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
      },
    },
  );
  aiBackendStartedByApp = true;

  aiBackendProcess.stdout.on("data", (data) =>
    appendLog(`[AI] ${data.toString().trimEnd()}`),
  );
  aiBackendProcess.stderr.on("data", (data) =>
    appendLog(`[AI] ${data.toString().trimEnd()}`),
  );
  aiBackendProcess.once("error", (error) =>
    appendLog(`AI backend process error: ${error.stack || error}`),
  );
  aiBackendProcess.once("exit", (code, signal) => {
    appendLog(`AI backend exited with code=${code} signal=${signal}`);
    aiBackendProcess = null;
    aiBackendStartedByApp = false;
  });

  const ready = await waitForAiBackend();
  appendLog(
    ready
      ? "Local AI backend is ready for automatic captions."
      : "Local AI backend did not become ready before timeout.",
  );
  return ready;
}

function startServer() {
  const webRoot = app.isPackaged
    ? path.join(process.resourcesPath, "web")
    : path.join(__dirname, "web");
  const serverDirectory = path.join(webRoot, "apps", "web");
  const serverPath = path.join(serverDirectory, "server.js");

  if (!fs.existsSync(serverPath)) {
    throw new Error(`OpenCut server file was not found: ${serverPath}`);
  }

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_ENV: "production",
    HOSTNAME: HOST,
    PORT: String(PORT),
    NEXT_PUBLIC_SITE_URL: APP_URL,
    NEXT_PUBLIC_MARBLE_API_URL: "https://api.marblecms.com",
    DATABASE_URL: "postgresql://opencut:opencut@127.0.0.1:5432/opencut",
    BETTER_AUTH_SECRET: getOrCreateAuthSecret(),
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
    UPSTASH_REDIS_REST_TOKEN: "example_token",
    MARBLE_WORKSPACE_KEY: "desktop-local",
    FREESOUND_CLIENT_ID: "desktop-local",
    FREESOUND_API_KEY: "desktop-local",
  };

  appendLog(`Starting server process from ${serverPath}`);
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: serverDirectory,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => appendLog(data.toString().trimEnd()));
  serverProcess.stderr.on("data", (data) => appendLog(data.toString().trimEnd()));
  serverProcess.once("error", (error) =>
    appendLog(`Server process error: ${error.stack || error}`),
  );
  serverProcess.once("exit", (code, signal) => {
    appendLog(`Server exited with code=${code} signal=${signal}`);
    serverProcess = null;
    if (!isQuitting && mainWindow) {
      dialog.showErrorBox(
        "OpenCut 服务已停止",
        "本地服务意外退出。可在应用数据目录的 server.log 中查看详细信息。",
      );
    }
  });
}

function waitForServer(timeoutMs = 60000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(`${APP_URL}/projects`, (response) => {
        response.resume();
        if ((response.statusCode || 500) < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.setTimeout(1500, () => request.destroy());
      request.on("error", retry);
    };

    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`OpenCut server did not become ready at ${APP_URL}`));
        return;
      }
      setTimeout(check, 300);
    };

    check();
  });
}

function createWindow() {
  const isHiddenTest = process.env.OPENCUT_TEST_HIDDEN === "1";
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#0a0a0a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(APP_URL)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (!isHiddenTest) mainWindow.show();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    setTimeout(async () => {
      try {
        const localeStatus = await mainWindow.webContents.executeJavaScript(
          `({ lang: document.documentElement.lang, translated: /项目|新建项目|全部项目/.test(document.body.innerText) })`,
        );
        appendLog(`Chinese UI status: ${JSON.stringify(localeStatus)}`);
      } catch (error) {
        appendLog(`Chinese UI check failed: ${error.message}`);
      }
    }, 800);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(`${APP_URL}/projects`);
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;

  const pid = serverProcess.pid;
  if (process.platform === "win32" && pid) {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {});
  } else {
    serverProcess.kill("SIGTERM");
  }
  serverProcess = null;
}

function stopAiBackend() {
  if (!aiBackendStartedByApp || !aiBackendProcess || aiBackendProcess.killed) return;

  const pid = aiBackendProcess.pid;
  if (process.platform === "win32" && pid) {
    execFile("taskkill", ["/pid", String(pid), "/t", "/f"], () => {});
  } else {
    aiBackendProcess.kill("SIGTERM");
  }
  aiBackendProcess = null;
  aiBackendStartedByApp = false;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      startServer();
      await waitForServer();
      createWindow();
      void ensureAiBackend().catch((error) =>
        appendLog(`Unable to start local AI backend: ${error.stack || error}`),
      );
    } catch (error) {
      appendLog(error.stack || String(error));
      dialog.showErrorBox(
        "OpenCut 启动失败",
        `${error.message}\n\n详细日志：${path.join(app.getPath("userData"), "server.log")}`,
      );
      app.quit();
    }
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  stopServer();
  stopAiBackend();
});

app.on("window-all-closed", () => app.quit());
