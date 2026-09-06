import { spawnSync } from "node:child_process";
import process from "node:process";

const mirrorPath = "compat/upstream/shiki";

function checkGit(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) return;

  const details = `${result.stdout || ""}${result.stderr || ""}`.trim();
  console.error(
    `[check-shiki-compat-clean] compatibility mirror is dirty${details ? `:\n${details}` : ""}`,
  );
  process.exit(result.status || 1);
}

checkGit(["diff", "--quiet", "--", mirrorPath]);
checkGit(["diff", "--cached", "--quiet", "--", mirrorPath]);
console.log("[check-shiki-compat-clean] compatibility mirror is clean");
