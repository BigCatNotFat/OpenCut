const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const webAppRoot = path.join(repoRoot, "apps", "web");
const standaloneRoot = path.join(webAppRoot, ".next", "standalone");
const staticRoot = path.join(webAppRoot, ".next", "static");
const publicRoot = path.join(webAppRoot, "public");
const targetRoot = path.join(__dirname, "web");
const targetAppRoot = path.join(targetRoot, "apps", "web");

if (!fs.existsSync(path.join(standaloneRoot, "apps", "web", "server.js"))) {
  throw new Error(
    "Next.js standalone output was not found. Run `bun run --cwd apps/web build` from the repository root first.",
  );
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.cpSync(standaloneRoot, targetRoot, {
  recursive: true,
  force: true,
  dereference: true,
});
fs.mkdirSync(path.join(targetAppRoot, ".next"), { recursive: true });
fs.cpSync(staticRoot, path.join(targetAppRoot, ".next", "static"), {
  recursive: true,
  force: true,
  dereference: true,
});
fs.cpSync(publicRoot, path.join(targetAppRoot, "public"), {
  recursive: true,
  force: true,
  dereference: true,
});

console.log(`Prepared standalone web assets in ${targetRoot}`);
