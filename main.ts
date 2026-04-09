import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf-8"));
const eventName = process.env.GITHUB_EVENT_NAME!;
const repo = process.env.GITHUB_REPOSITORY!;
const issueNumber: number = event.issue.number;

async function run(cmd: string[], opts?: { stdin?: any }): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "inherit",
    stdin: opts?.stdin,
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout: stdout.trim() };
}

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await run(["gh", ...args]);
  return stdout;
}

// Load reaction state from preinstall
const reactionState = existsSync("/tmp/reaction-state.json")
  ? JSON.parse(readFileSync("/tmp/reaction-state.json", "utf-8"))
  : null;

try {
  // --- Fetch issue ---
  const title = await gh("issue", "view", String(issueNumber), "--json", "title", "--jq", ".title");
  const body = await gh("issue", "view", String(issueNumber), "--json", "body", "--jq", ".body");

  // --- Resolve session ---
  mkdirSync("state/issues", { recursive: true });
  mkdirSync("state/sessions", { recursive: true });

  let mode = "new";
  let sessionPath = "";
  const mappingFile = `state/issues/${issueNumber}.json`;

  if (existsSync(mappingFile)) {
    const mapping = JSON.parse(readFileSync(mappingFile, "utf-8"));
    if (existsSync(mapping.sessionPath)) {
      mode = "resume";
      sessionPath = mapping.sessionPath;
      console.log(`Found existing session: ${sessionPath}`);
    } else {
      console.log("Mapped session file missing, starting fresh");
    }
  } else {
    console.log("No session mapping found, starting fresh");
  }

  // --- Configure git ---
  await run(["git", "config", "user.name", "gitclaw[bot]"]);
  await run(["git", "config", "user.email", "gitclaw[bot]@users.noreply.github.com"]);

  // --- Build prompt ---
  let prompt: string;
  if (eventName === "issue_comment") {
    prompt = event.comment.body;
  } else {
    prompt = `${title}\n\n${body}`;
  }

  // --- Run agent ---
  const storyPrompt = `你现在是 StoryClaw，一位顶级的畅销书作家和王牌编剧。你的任务是根据用户的要求创作引人入胜的故事、塑造丰满的角色。请不要写代码，只写故事。用户的要求是：\n\n${prompt}`;

const piArgs = ["bunx", "pi", "--mode", "json", "--model", "gemini-2.5-flash", "--provider", "google", "--session-dir", "./state/sessions", "-p", storyPrompt];
  if (mode === "resume" && sessionPath) {
    piArgs.push("--session", sessionPath);
  }

  const pi = Bun.spawn(piArgs, { stdout: "pipe", stderr: "ignore" });
  const tee = Bun.spawn(["tee", "/tmp/agent-raw.jsonl"], { stdin: pi.stdout, stdout: "inherit" });
  await tee.exited;

  // Extract text from the agent's final message
  const tac = Bun.spawn(["tac", "/tmp/agent-raw.jsonl"], { stdout: "pipe" });
  const jq = Bun.spawn(
    ["jq", "-r", "-s", '[ .[] | select(.type == "message_end") ] | .[0].message.content[] | select(.type == "text") | .text'],
    { stdin: tac.stdout, stdout: "pipe" }
  );
  const agentText = await new Response(jq.stdout).text();
  await jq.exited;

  // Find latest session file
  const { stdout: latestSession } = await run([
    "bash", "-c", "ls -t state/sessions/*.jsonl 2>/dev/null | head -1",
  ]);

  // --- Save session mapping ---
  if (latestSession) {
    writeFileSync(
      mappingFile,
      JSON.stringify({
        issueNumber,
        sessionPath: latestSession,
        updatedAt: new Date().toISOString(),
      }, null, 2) + "\n"
    );
    console.log(`Saved mapping: issue #${issueNumber} -> ${latestSession}`);
  } else {
    console.log("Warning: no session file found to map");
  }

  // --- Commit and push ---
  await run(["git", "add", "-A"]);
  const { exitCode } = await run(["git", "diff", "--cached", "--quiet"]);
  if (exitCode !== 0) {
    await run(["git", "commit", "-m", `gitclaw: work on issue #${issueNumber}`]);
  }

  for (let i = 1; i <= 3; i++) {
    const push = await run(["git", "push", "origin", "main"]);
    if (push.exitCode === 0) break;
    console.log(`Push failed, rebasing and retrying (${i}/3)...`);
    await run(["git", "pull", "--rebase", "origin", "main"]);
  }

  // --- Comment on issue ---
  const commentBody = agentText.slice(0, 60000);
  await gh("issue", "comment", String(issueNumber), "--body", commentBody);

} finally {
  // --- Remove eyes reaction ---
  if (reactionState?.reactionId) {
    try {
      const { reactionId, reactionTarget, commentId } = reactionState;
      if (reactionTarget === "comment" && commentId) {
        await gh("api", `repos/${repo}/issues/comments/${commentId}/reactions/${reactionId}`, "-X", "DELETE");
      } else {
        await gh("api", `repos/${repo}/issues/${issueNumber}/reactions/${reactionId}`, "-X", "DELETE");
      }
    } catch (e) {
      console.error("Failed to remove reaction:", e);
    }
  }
}
