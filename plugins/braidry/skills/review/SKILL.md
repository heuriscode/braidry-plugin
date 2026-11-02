---
name: review
description: Run Braidry's Literature scoping review braid - A scoping review you can defend: every reference checked, every claim tested by a blind checker. Use when the person asks for this, or types /braidry:review.
---

# Braidry: Literature scoping review

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

1. Call `braidry_run_start` with `braid: "fairlead.lit_scoping_review"`, a fresh random `nonce` (for example a new UUID) and `prompt` set to the person's request, verbatim.
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

The person can stop the run at any point. When they say so in their own words, call `braidry_decision` with `kind: "abandon"` (and the open card's `step_id`, if one is open), with `text` saying what they said. If Braidry gives you its own stop question, ask it unchanged. Never stop a run on your own. The record is frozen as it stands; the conversation carries on as usual, or a new run starts with `/braidry:review`.

## This braid: the focus

**Refine (the first step after the web check):** turn the person's request into an agreed focus: a clear research question, its scope, and what counts as in or out. Write it on a focus card, `braidry_card({ card: "focus", step_id, focus })`, ask its question exactly as given (the focus is inside it, so post nothing before it); if they want a change, redraft and write a new focus card. When they accept, call `braidry_decision` with `kind: "focus_accept"`, `step_id`, a one-sentence `text`, and `focus` set to exactly the focus on the card: the agreed focus as JSON with exactly these fields:

   ```json
   {"starting_prompt": "<the person's request, verbatim>",
    "question": "What does the evidence say about ...?",
    "sub_questions": ["...", "..."],
    "goal": "A scoping review of ...",
    "audience": "Who will read it",
    "decision": "What the review will inform",
    "scope": {"period": "2016-2026", "jurisdictions": ["AU"], "source_types": ["evaluation", "peer-reviewed study"]},
    "must_include": [],
    "out_of_scope": ["..."],
    "what_good_looks_like": ["Every claim traced to a source"],
    "would_change_view": "What evidence would change the conclusion",
    "personal_info_detected": false}
   ```

   Set `personal_info_detected` to true if the request names or describes a private person. If the server says the focus is not valid, fix the fields it names, and ask the person again only if the meaning changed.

**Decide steps** in this braid record the person's answer with `kind: "escalation"`.
