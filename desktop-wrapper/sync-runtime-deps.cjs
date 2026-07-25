const fs = require("fs");
const path = require("path");

const sourceRootCandidates = [
  path.resolve(__dirname, "..", "node_modules"),
  path.resolve(__dirname, "..", "OpenCut-classic", "node_modules"),
];
const sourceRoot = sourceRootCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "next", "package.json")),
);
if (!sourceRoot) {
  throw new Error(
    "Could not find the repository node_modules directory. Run bun install first.",
  );
}
const targetRoot = path.resolve(
  __dirname,
  process.argv[2] || path.join("web", "apps", "web", "node_modules"),
);

const queue = ["next", "react", "react-dom"];
const seen = new Set();

function packageDirectory(root, name) {
  return path.join(root, ...name.split("/"));
}

while (queue.length > 0) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);

  const sourceDirectory = packageDirectory(sourceRoot, name);
  const sourcePackage = path.join(sourceDirectory, "package.json");
  if (!fs.existsSync(sourcePackage)) {
    console.warn(`Missing source dependency: ${name}`);
    continue;
  }

  const targetDirectory = packageDirectory(targetRoot, name);
  const targetPackage = path.join(targetDirectory, "package.json");
  if (!fs.existsSync(targetPackage)) {
    fs.mkdirSync(path.dirname(targetDirectory), { recursive: true });
    fs.cpSync(sourceDirectory, targetDirectory, {
      recursive: true,
      force: true,
      dereference: true,
    });
    console.log(`Copied ${name}`);
  }

  const manifest = JSON.parse(fs.readFileSync(sourcePackage, "utf8"));
  for (const dependency of Object.keys(manifest.dependencies || {})) {
    queue.push(dependency);
  }
}

console.log(`Runtime dependency closure complete: ${seen.size} packages`);
