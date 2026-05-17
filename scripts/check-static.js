const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const scripts = [
  path.join(root, "server.js"),
  path.join(root, "public", "app.js"),
  path.join(root, "scripts", "check-static.js")
];

for (const file of scripts) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const manifestPath = path.join(root, "public", "manifest.webmanifest");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!manifest.name || !manifest.start_url || !Array.isArray(manifest.icons)) {
  throw new Error("Manifest is missing required app metadata.");
}

const vercelConfig = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
if (vercelConfig.outputDirectory !== "public" || vercelConfig.framework !== null) {
  throw new Error("vercel.json must deploy the static public directory with no framework preset.");
}
if (vercelConfig.buildCommand !== "npm run build") {
  throw new Error("vercel.json must run the static validation build.");
}

const index = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
for (const asset of ["/styles.css", "/app.js", "/manifest.webmanifest"]) {
  if (!index.includes(asset)) {
    throw new Error(`index.html does not reference ${asset}`);
  }
}

console.log("Static checks passed.");
