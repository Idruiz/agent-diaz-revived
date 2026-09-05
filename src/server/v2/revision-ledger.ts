import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface V2RevisionLedgerEntry {
  attempt: number;
  planSha: string;
  status: "validated" | "rejected";
  buildId?: string;
  failureClass?: string;
  ruleOrPart?: string;
  message?: string;
  stagnationCount?: number;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function writeV2AttemptPlan(
  workRoot: string,
  attempt: number,
  plan: unknown,
): { attemptDir: string; planPath: string; planSha: string } {
  const attemptDir = path.join(workRoot, `attempt-${attempt}`);
  fs.mkdirSync(attemptDir, { recursive: true });
  const planPath = path.join(attemptDir, "plan.json");
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return { attemptDir, planPath, planSha: sha256Json(plan) };
}

export function appendV2RevisionEntry(
  workRoot: string,
  entry: V2RevisionLedgerEntry,
): void {
  fs.mkdirSync(workRoot, { recursive: true });
  fs.appendFileSync(
    path.join(workRoot, "REVISION_HISTORY.jsonl"),
    `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}

export function listV2RecoveryFiles(
  workRoot: string,
): Array<{ workspacePath: string; hostPath: string }> {
  const out: Array<{ workspacePath: string; hostPath: string }> = [];
  const historyPath = path.join(workRoot, "REVISION_HISTORY.jsonl");
  if (fs.existsSync(historyPath))
    out.push({
      workspacePath: "recovery/REVISION_HISTORY.jsonl",
      hostPath: historyPath,
    });

  if (!fs.existsSync(workRoot)) return out;
  const attempts = fs
    .readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      number: Number(entry.name.replace("attempt-", "")),
    }))
    .sort((a, b) => b.number - a.number);
  const latest = attempts[0];
  if (latest) {
    const planPath = path.join(workRoot, latest.name, "plan.json");
    if (fs.existsSync(planPath))
      out.push({
        workspacePath: "recovery/LATEST_PLAN.json",
        hostPath: planPath,
      });
  }
  return out;
}
