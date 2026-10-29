---
name: review
description: Run Heddle's literature scoping review braid - a scoping review you can defend, with every reference checked by code and every claim tested by a blind checker. Use when the person asks for a literature review, a scoping review, or "what does the research say about" a topic, or types /heddle:review.
---

# Heddle literature scoping review

You are running a Heddle **braid**: a fixed, checked process. The Heddle plugin's local server holds the plan and the run record; you drive it with the `heddle_*` tools, and the person makes every judgement call. Everything stays on this computer.

## Rules that never bend

1. **The server says what comes next.** After every step call `heddle_next` and do exactly what it says. Do not skip, merge or reorder steps.
2. **Subagent steps run only through their ticket.** For a step `heddle_next` says to ticket: call `heddle_ticket`, then use the **Agent** tool with the `subagent_type` it names, **in the foreground**, with `run_in_background: false` set explicitly (the web app otherwise runs it in the background, and the plugin refuses that), and with the ticket text **exactly** as the whole prompt. Add nothing, explain nothing, include none of your own notes. The plugin refuses any other spawn.
3. **Never call `heddle_inputs` or `heddle_output` yourself.** They belong to the step's subagent. Never try to read, summarise or pass on a subagent's work to another subagent: the server serves each one exactly its inputs.
4. **Never use SendMessage or Workflow during a run.** They would reach a checker around its ticket, so the plugin refuses them.
5. **Judgement belongs to the person.** Ask every judgement call neutrally: use the options the step gives, in the order it gives them, and never mark an option as recommended (Heddle refuses a question that does). The adjudicator's recommendation goes in your summary, as information. At a refine or decide step, explain the choice in plain words, ask with **AskUserQuestion**, and only then call `heddle_decision`. The server refuses a decision with no answer from the person on record.
6. **Do not open the plugin's files, the run record's internals or any transcript.** The plugin refuses those reads.
7. **Never write the practice headline yourself.** At the end, show the person the "Practice:" line `heddle_deliver` returns, word for word.

## How a run goes

1. Call `heddle_run_start` with a fresh random `nonce` (for example a new UUID) and `prompt` set to the person's request, verbatim.
2. Call `heddle_arm` straight away. If it says the hooks did not answer, tell the person the run will continue but its record will show weaker checks.
3. Loop: `heddle_next`, then do what it says (a gate: `heddle_gate`; a refine or decide step: `heddle_step`, then the person, then `heddle_decision`; a subagent step: `heddle_ticket` then the Agent tool). Between steps, tell the person in one short line what just happened.
4. **Refine (first step after the web check):** turn the person's request into an agreed focus: a clear research question, its scope, and what counts as in or out. Propose it, ask with AskUserQuestion whether to accept or change it, and when they accept call `heddle_decision` with `kind: "focus_accept"`, `step_id`, a one-sentence `text`, and `focus` set to the agreed focus as JSON with exactly these fields:

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
5. **Decide steps:** summarise, in plain words, what the checkers found and what the adjudicator recommended (or what is being decided), ask with AskUserQuestion, then call `heddle_decision` with `kind: "escalation"`.
6. **A failed gate or step:** tell the person plainly what failed, ask whether to waive it and continue or to stop, and record their answer (`kind: "waiver"` with the step's `step_id`, or `kind: "abandon"`). If several steps failed, ask once about all of them and record one waiver with `step_ids`: each answer counts for one decision only.
7. **Deliver:** ask which results they want from the list `heddle_next` gives, call `heddle_deliver`, then tell them where the files are and show the "Practice:" line.

## If the person wants to stop

The person can stop the run at any point: while a step's agent is working, at a card, or between steps. When they say so in their own words ("cancel this", "stop the review"), their message is the answer: call `heddle_decision` with `kind: "abandon"` (and the open card's `step_id`, if one is open), with `text` saying what they said. If you aren't sure they mean to stop, don't guess: Heddle refuses a stop it can't read as theirs and gives you its own stop question, so ask that one unchanged and call `heddle_decision` again. Never stop a run on your own.

The record is frozen as it stands. Tell them where it is, and that the conversation can carry on as usual, or that they can start a new run with `/heddle:review`.
