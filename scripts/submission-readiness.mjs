#!/usr/bin/env node
/** Offline inventory only. A true field records a human-checked action; it does not execute it. */
import { readFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(root, "docs/submission");
const state = JSON.parse(readFileSync(resolve(dir, "readiness.json"), "utf8"));
let failed = 0;
function check(ok, message) { console.log(`${ok ? "PASS" : "TODO"} ${message}`); if (!ok) failed++; }
function file(path) { return typeof path === "string" && existsSync(resolve(root, path)) && statSync(resolve(root, path)).size > 0; }
console.log(`Agent Wallet submission inventory. Conservative cutoff ${state.deadline}. No deployment or external writes.`);
for (const item of JSON.parse(readFileSync(resolve(dir, "templates/sources.json"), "utf8")).files) {
  const path = resolve(dir, "templates", item.file);
  check(existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === item.sha256,
    `Official original matches its downloaded SHA-256: ${item.file}`);
}
for (const path of ["docs/submission/ready/Agent-Wallet-technical-document-en.docx", "docs/submission/ready/Agent-Wallet-security-self-assessment-en.docx", "docs/submission/ready/Agent-Wallet-execution-evidence-en.docx", "docs/submission/EXECUTION-EVIDENCE.md", "evals/TASKS.md", "README.md"]) check(file(path), path);
check(state.registeredTeamNameConfirmed === true && state.registrationFormCompletedPrivately === true, "Owner confirmed registered team and completed actual registration form privately");
check(state.technicalDocumentReviewedForFinalRelease === true, "Technical document reflects the final release and registered team name");
check(file(state.deck?.path) && /\.pptx$/i.test(state.deck.path) && Number.isFinite(state.deck.durationSeconds) && state.deck.durationSeconds > 0 && state.deck.durationSeconds <= 600 && state.deck.english === true, "Finished English PPTX exists and rehearsal is at most 10 minutes");
check(file(state.video?.path) && /\.(mp4|mov|webm)$/i.test(state.video.path) && Number.isFinite(state.video.durationSeconds) && state.video.durationSeconds > 0 && state.video.durationSeconds <= 300 && state.video.englishSubtitles === true, "Recorded demo exists, has English subtitles and is at most 5 minutes");
check(typeof state.finalCommit === "string" && /^[0-9a-f]{40}$/.test(state.finalCommit) && file(state.finalAcceptanceLog), "Full final commit and actual acceptance log recorded");
check(file(state.freshEvidenceLog), "Fresh read-only evidence verification log retained");
for (const field of ["judgeAccessCheckedAt", "physicalPhoneFlowCheckedAt"]) check(typeof state[field] === "string" && Number.isFinite(Date.parse(state[field])), `${field} recorded after the actual check`);
check(state.secretsAndSharingReviewComplete === true, "Secret and repository-sharing review complete before code access is supplied");
console.log(state.submissionAcknowledgementStoredPrivately ? "RECORDED Owner has stored the actual submission acknowledgement privately." : "PENDING Owner must send the final entry and retain the actual acknowledgement. Nothing has been submitted by this script.");
console.log(`${failed} incomplete checks. This inventory does not certify product behavior or video content.`);
process.exitCode = failed ? 1 : 0;
