const { execFileSync } = require("node:child_process");

const status = execFileSync("git", ["status", "--porcelain", "--", "dist"], {
  encoding: "utf8",
});

if (status.trim().length > 0) {
  console.error("dist is not up to date. Run npm run build and commit the generated output.");
  if (process.env.GITHUB_ACTIONS) {
    console.error("The rebuilt bundle is attached to this run as the 'dist' artifact.");
  }
  console.error(status.trimEnd());
  process.exit(1);
}

console.log("dist is up to date.");
