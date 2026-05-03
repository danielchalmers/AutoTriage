#!/usr/bin/env node
// Normalizes line endings to LF in all text files in the dist/ directory.
// This ensures consistent output regardless of the build OS (Windows vs Linux/macOS).
const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
const textExtensions = new Set([".js", ".map", ".txt"]);

let changed = 0;
for (const name of fs.readdirSync(distDir)) {
  if (!textExtensions.has(path.extname(name))) continue;
  const file = path.join(distDir, name);
  const original = fs.readFileSync(file, "utf8");
  if (!original.includes("\r\n")) continue;
  fs.writeFileSync(file, original.replace(/\r\n/g, "\n"), "utf8");
  changed++;
  console.log(`Normalized: ${name}`);
}
if (changed === 0) console.log("dist/ already uses LF line endings.");
