# Submission package

Finish the current product and its reproducible demo before adding features. This directory contains the judge-facing documents and the original official templates. It does not mean the entry has been submitted or that the final release has passed acceptance.

Use **20 October 2026, 23:59 Beijing time, UTC+8**, as the submission cutoff. That is **20 October, 21:29 India time** and **15:59 UTC**. The live site says 24:00; an earlier rules PDF says 23:59 and gives inconsistent conversions. The earlier instant is the safe operational deadline. Submit ahead of it.

## What the current official site requires

Verified on 17 October 2026 from the [official site](https://fintechathon.g-ican.com/) and its [International Track process text](https://fintechathon.g-ican.com/js/chunk-4516c2dd.7f79eeba.js).

| Material | Current official status | File and remaining action |
|---|---|---|
| Team registration form | Required | Fill the original [XLSX](templates/team-information-form.xlsx) with actual registered team and member details. Keep personal information outside the public repository. |
| English technical document | Required | [Filled official DOCX](ready/Nudge-technical-document-en.docx); editable source [TECHNICAL.md](TECHNICAL.md). Confirm registered team name and final release. |
| Presentation deck, at most 10 minutes | Required | [Content and notes](DECK.md), [official PPTX](templates/presentation-template.pptx). Export the finished English presentation and rehearse it. An untouched template is not a finished deck. |
| Demo video, at most 5 minutes | Required | [Timed recording script](VIDEO-SCRIPT.md), [official guide](templates/demo-video-guide-en.docx). Record real product behavior, add English subtitles and check duration. A script is not a video. |
| Source code and README | Optional on current live site | This repository, [README](../../README.md), deployment instructions and tests. Include access to a fixed final commit. |
| Security self-assessment | Optional on current live site | [Filled official DOCX](ready/Nudge-security-self-assessment-en.docx), [full assessment](SELF-ASSESSMENT.md). |
| Execution evidence | Optional on current live site | [Filled official DOCX](ready/Nudge-execution-evidence-en.docx), [receipt index](EXECUTION-EVIDENCE.md), [task outcomes](../../evals/TASKS.md). Topic F evidence should include real on-chain transaction hashes. |

The three optional items are still part of our planned entry because they substantiate the security and task-completion claims. Older rules describe the full six-item checklist and call video optional; the current live process and downloaded video guide call video required. We satisfy the stricter combined set. The downloaded originals explicitly call security/evidence optional. The [source manifest](templates/sources.json) records URLs, hashes and last-modified headers; originals have not been edited.

English is the International Track language. Registration is by official email according to the live process. The listed organiser contact is `info@ican-x.com`. The owner sends the final entry and retains the actual acknowledgement. No agent should invent a registration confirmation or an organiser decision about testnet eligibility. The owner should check the exact delivery instructions in their registration correspondence before sending.

## Release checks chosen by this team

These checks are our product readiness gates, not additional competition rules:

1. Freeze features. Merge only reviewed work needed to make the existing owner and assistant journeys work. Defer unneeded OAuth, new channels and other expansions.
2. Run unit/type checks and the existing failure/security suites against the exact final commit. Run the read-only evidence check with `bash scripts/verify-evidence.sh`; retain its dated output. Historical measurements remain labelled historical until rerun.
3. Check judge access from a fresh session, current deployed versions, account isolation and the phone passkey flow. Record the final happy path, held/cancelled payment, over-limit owner approval, stolen-key refusal and freeze. Use test data and test tokens.
4. Resolve the secret scan/history issue before publishing or sharing code access. Verify licence and third-party attribution. Never put approval links, bearer keys, judge keys or personal data in public files.
5. Finish the actual deck, video and registration form. Confirm working download links from a separate browser and provide an offline fallback. Check the host from the review region if possible; a Vercel-only demo can be inaccessible in mainland China.
6. Submit the exact final package before the cutoff and store the real acknowledgement privately. Automatic preview deployments remain disabled to conserve Vercel quota.

The owner needs to provide the registered team/member details, record or supply the physical-phone segment, confirm judge access/share policy, and send the final submission. Agents can finish content, product fixes, tests, evidence checks, slide export and packaging. An organiser reply about acceptance of testnet hashes is useful clarification; no current reply is on file, so do not claim one.

## Check the package

Run `node scripts/submission-readiness.mjs`. It checks template integrity, required files, receipt-data shape and the explicit release checklist in [readiness.json](readiness.json). It exits nonzero while owner inputs or deliverables are missing. It does not deploy, spend tokens, send email, mutate a wallet or turn historical results into a fresh test run.

The three filled DOCX files use the official templates, with the original package parts preserved except document text. They describe source commit `6533942`, historical measurements and known limits. Their metadata deliberately asks for confirmation of the registered team name and final release. They are ready for review, not falsely labelled as final submitted documents.
