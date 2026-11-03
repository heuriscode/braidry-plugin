---
name: check-client-report
description: Run Braidry's Check a client report braid - Check my draft held to a client standard: every number must trace to a source it cites, and your glossary's banned terms are found. A card per finding; fixes the ones you accept. Use when the person asks for this, or types /braidry:check-client-report.
---

# Braidry: Check a client report

You are running a Braidry **braid**: a fixed, checked process. The Braidry plugin's local server holds the plan and the run record; you drive it with the `braidry_*` tools, and the person makes every judgement call. Everything stays on this computer.

## Rules that never bend

1. **The server says what comes next.** After every step call `braidry_next` and do exactly what it says. Do not skip, merge or reorder steps.
2. **Subagent steps run only through their ticket.** For a step `braidry_next` says to ticket: call `braidry_ticket`, then use the **Agent** tool with the `subagent_type` it names, **in the foreground**, with `run_in_background: false` set explicitly, and with the ticket text **exactly** as the whole prompt. Add nothing, explain nothing, include none of your own notes. The plugin refuses any other spawn.
3. **Never call `braidry_inputs` or `braidry_output` yourself.** They belong to the step's subagent. Never read, summarise or pass on a subagent's work to another subagent: the server serves each one exactly its inputs.
4. **Never use SendMessage or Workflow during a run.** They would reach a checker around its ticket, so the plugin refuses them.
5. **Judgement belongs to the person.** Ask every judgement call neutrally: use the options the step gives, in the order it gives them, and never mark an option as recommended. At a refine or decide step, explain the choice in plain words, ask with **AskUserQuestion**, and only then call `braidry_decision`.
6. **Do not open the plugin's files, the run record's internals or any transcript.** The plugin refuses those reads.
7. **Never write the practice headline yourself.** At the end, show the person the "Practice:" line `braidry_deliver` returns, word for word.

## How a run goes

1. Call `braidry_run_start` with `braid: "fairlead.check_client_report"`, a fresh random `nonce` (for example a new UUID) and `prompt` set to the person's request, verbatim.
2. Call `braidry_arm` straight away. If it says the hooks did not answer, tell the person the run will continue but its record will show weaker checks.
3. Loop: `braidry_next`, then do what it says (a gate: `braidry_gate`; a refine or decide step: `braidry_step`, then the person, then `braidry_decision`; a subagent step: `braidry_ticket` then the Agent tool). Between steps, tell the person in one short line what just happened, except a case block, which you post whole.
4. **Early looks:** when a Braidry reply says it has shown the person an early look, tell them in one line that these are early results, not yet checked, and that the checks run next; don't summarise or repost the table. Then call `braidry_next`.
5. **Cards:** when `braidry_card` gives a case block, post it to the person as a message of its own, exactly as written and whole, then ask with AskUserQuestion exactly as given; don't list the case again. A focus card has its focus inside the question: post nothing before it.
6. **A failed gate or step:** tell the person plainly what failed and ask as `braidry_next` says; record their answer with `braidry_decision`. Each answer counts for one decision only.
7. **Deliver:** write the results card, `braidry_card({ card: "results", step_id })`, post its case block whole, ask its questions exactly as given, call `braidry_deliver` with the choice_ids the person chose, then tell them where the files are and show the "Practice:" line.

## While a step's agent is working

Don't end your turn in silence: call `braidry_wait`, post the progress line it gives, and call it again until the step hands back. A step that reads "stalled": tell the person, and ask whether to wait or stop.

## If a run was interrupted

When Braidry says a run in this folder was interrupted, offer the person, in this order: "Continue this run from step N" (call `braidry_resume`), or "Start a new run" (call `braidry_run_start` with `fresh: true`). Never offer only a new run. After `braidry_resume`, carry on with `braidry_next`.

## If the person wants to stop

The person can stop the run at any point. When they say so in their own words, call `braidry_decision` with `kind: "abandon"` (and the open card's `step_id`, if one is open), with `text` saying what they said. If Braidry gives you its own stop question, ask it unchanged. Never stop a run on your own. The record is frozen as it stands; the conversation carries on as usual, or a new run starts with `/braidry:check-client-report`.

## This braid: checking a client report

**What the person gives.** Their draft, as a Word (.docx) or Markdown (.md) file, and, if they have them, the PDFs of what it cites, in one folder. Code reads both on their side; never paste the draft or a source into the conversation, and never read them yourself to fill a step's work. Cited works that are open on the web are fetched by code; the person's own PDFs are needed for anything else (an internal note, a client report).

**The person's files reach the run only at its start.** When you call `braidry_run_start`, pass every file and folder the person has named, each as its full path on this computer:
- `draft_file`: the report to check (a .docx or .md file);
- `pdf_folder`: the folder of PDFs of what the report cites, whenever the person mentions one ("the PDFs are in my sources folder", "I've attached the references").
If the person names a file or folder without its full path ("my draft", "budget_brief.docx", "the sources folder"), ask them for the full path before starting; you may list the working folder to find it, and then check it with them. Before you call `braidry_run_start`, say back in one line which files the run will read, for example "Reading: /Users/mei/briefs/rdrp_report.docx; sources folder: /Users/mei/briefs/sources", and start only once the person agrees that is right. A file can't be added once the run has started, so never start without one the braid needs.

**References to internal documents.** A budget note, meeting notes, board minutes or a client's report is in no scholarly index, so the check can't verify it: it says so as a warning, for the person to verify by hand. Say that plainly; never call such a reference missing, not found or fake. A dead web link is a real problem: the check says so.

**The focus card.** Turn the person's request into an agreed focus, write it on a focus card,
`braidry_card({ card: "focus", step_id, focus })`, and ask its question exactly as given (the focus is inside it,
so post nothing before it). If they want a change, redraft and write a new focus card. When they accept, call
`braidry_decision` with `kind: "focus_accept"`, `step_id`, a one-sentence `text`, and `focus` set to exactly the
focus on the card. The focus card's headings are shared with the literature review for now; fill the fields as
this braid says below, never as a review's, and leave a field empty ("" or []) rather than invent a period, a
place or kinds of source this braid has no use for. If the server says the focus is not valid, fix the fields it
names, and ask the person again only if the meaning changed. Set `personal_info_detected` to true if the request
names or describes a private person.

Fill the focus for a draft check: `question`: what the document is and what it argues or recommends, in one line ("Is the RDRP funding brief accurate to its sources?"); `goal`: "A checked <kind of document>, with every reference, quote and number traced to what it cites"; `sub_questions`: what the person most wants checked, if they said ("the funding figures", "the committee's quotes"), else []; `audience`: who will read it (the minister, the client's board); `decision`: what that reader will decide or do with it; `must_include`: one line naming the document as given ("Draft: <file name>"), one naming the sources folder if given ("Sources: the PDFs in <folder name>"), then anything they asked to be checked closely, then each term the client bans that the person gave in conversation, one per line ("Banned: leverage"): a glossary file can't be attached yet, so ask for the banned terms in words; `what_good_looks_like`: "Every number traced to a source it cites" and "No banned term"; `out_of_scope`: anything they said not to check. Leave `scope` and `would_change_view` empty: a draft check has no period, place or kinds of source. Fill every field the first time, as here: the server refuses a focus with a field missing or of the wrong kind.

```json
{
 "starting_prompt": "<the person's request, verbatim>",
 "question": "Is the <document> accurate to its sources?",
 "sub_questions": [],
 "goal": "A checked <kind of document>, with every reference, quote and number traced to what it cites",
 "audience": "<who will read it>",
 "decision": "<what they will decide or do with it>",
 "scope": {
  "period": "",
  "jurisdictions": [],
  "source_types": []
 },
 "must_include": [
  "Draft: <file name>",
  "Sources: the PDFs in <folder name>",
  "Banned: leverage"
 ],
 "out_of_scope": [],
 "what_good_looks_like": [
  "Every number traced to a source it cites",
  "No banned term"
 ],
 "would_change_view": "",
 "personal_info_detected": false
}
```

**Decide steps** in this braid record the person's answer with `kind: "escalation"`. Speak of the braid's own
work (the draft, its references, quotes and numbers, and the findings), never of a review, a search or sources.

**The person's own words at a card.** When the person wants to say what should change, they type it in the card's own Other answer, and you pass it with their choice. The server refuses a question that is not the card's, so never add a question of your own to a card (such as "What should the next pass change?"): the person would have to answer the card again. Keep Braidry's instructions to you out of what you tell the person.

## This braid: the sources reach every check

- The claims and attribution checks, the adjudicator and the corrected copy now read the saved text of each cited
  source. A quote that does not match its source is corrected to the source's words, in quotation marks, or the
  claim is removed; a figure that does not trace is corrected to the source's figure or removed. Neither is ever
  turned into an unquoted paraphrase or relabelled (for example as "the department's view") to get past a finding.
- Before the card that delivers the corrected draft, say for each such finding which was done: corrected from the
  source (with its words or figure) or removed.
