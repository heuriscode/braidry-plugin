---
name: sample-size
description: Run Braidry's Sample size and power braid - How many people to recruit for a planned comparison or model: completers and recruitment after dropout computed in code from the inputs you state, every number rechecked. Use when the person asks for this, or types /braidry:sample-size.
---

# Braidry: Sample size and power

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

1. Call `braidry_run_start` with `braid: "fairlead.sample_size"`, a fresh random `nonce` (for example a new UUID) and `prompt` set to the person's request, verbatim.
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

The person can stop the run at any point. When they say so in their own words, call `braidry_decision` with `kind: "abandon"` (and the open card's `step_id`, if one is open), with `text` saying what they said. If Braidry gives you its own stop question, ask it unchanged. Never stop a run on your own. The record is frozen as it stands; the conversation carries on as usual, or a new run starts with `/braidry:sample-size`.

## This braid: show the sizes before the scenario card (read this first)

Before you ask the person to confirm the scenarios, and every time that card is asked again, post each scenario's
sizes as code computed them, as a table, and only then the card. Never ask that card without the sizes on screen,
even if the person has not asked for them (in the user test the card was asked twice with no size on screen):
- Read the sample size check's latest result in the run folder (`gate_io/s2g/`, the newest folder, `result.json`).
  Each evidence item named `sizes#<scenario id>` holds one scenario's completers (n1, n2, total), the people to
  recruit after dropout (recruit1, recruit2, recruit_total) and any SD limit (sd_used, d).
- One row a scenario: the scenario, its effect and power as the plan gives them, completers per arm and in total,
  recruitment per arm and in total, and the SD used where code set one. Quote every figure exactly as code wrote
  it; never work one out, round one or fill a gap.
- If the check did not finish, or wrote no sizes item for a scenario, say so in that row ("not computed in this
  run").
The card cannot show passing check results yet (dev is building this, R-c); until it can, this table is how the
person sees what they confirm.

## This braid: the focus

**Refine (the first step):** turn the person's request into an agreed focus for a sample size calculation. Write it on a focus card,
`braidry_card({ card: "focus", step_id, focus })`, and ask its question exactly as given (the focus is inside it, so
post nothing before it); if they want a change, redraft and write a new focus card. When they accept, call
`braidry_decision` with `kind: "focus_accept"`, `step_id`, a one-sentence `text`, and `focus` set to exactly the focus on
the card, as JSON with exactly these fields:

   ```json
   {"starting_prompt": "<the person's request, verbatim>",
    "question": "How many people does <the study> need to recruit to detect <the effect>?",
    "sub_questions": [],
    "goal": "Completers and recruitment after dropout, computed in code from the person's inputs.",
    "audience": "Who will read or use it",
    "decision": "How many to recruit.",
    "scope": {"period": "", "jurisdictions": [], "source_types": []},
    "must_include": [],
    "out_of_scope": [],
    "what_good_looks_like": [],
    "would_change_view": "",
    "personal_info_detected": false}
   ```

   This braid searches no literature: leave `scope` empty as shown unless the person names a period or place that
   matters, and use `must_include` for every number the person gives: the effect or difference, the SD and its pilot size, alpha, power, allocation and the dropout rate. `starting_prompt` is the person's words exactly, never a summary: code counts the numbers in it as the person's own, so the write-up may state them.
   Set `personal_info_detected` to true if the request names or describes a private person. If the server says the
   focus is not valid, fix the fields it names, and ask the person again only if the meaning changed.

   The focus card's own wording (for example "Shall the review go ahead") is the plugin's, not this braid's; if it
   reads oddly, tell the person in one line that this braid computes sample sizes; nothing is reviewed or searched.

**Decide steps** in this braid record the person's answer with `kind: "escalation"`.

## This braid: what to tell the person

- Every sample size, recruitment figure, d and SD confidence limit is computed in code. **Never do the arithmetic
  yourself**, never divide by the dropout rate yourself and never state a figure the run did not compute. If the
  person wants a figure the run does not give, say so plainly.
- Recruitment is completers per arm divided by one minus the dropout rate, rounded up, per arm and in total. If
  the person gives no dropout rate, ask for one (0 is a valid answer).
- The scenario card's case leads with the sizes code computed, one item per scenario.

## This braid: questions at a card

- If the person answers a card through "Other" with a question (for example "were my sample sizes calculated or
  not?"), answer it from the run record first, in plain words, then ask the card again. Never ask the card again
  without answering. Where the question is about figures, read the sample size check's latest result in the run
  folder (`gate_io/s2g/`, the newest folder, `result.json`): each evidence item named `sizes#<scenario id>` holds
  one scenario's completers (n1, n2, total), the people to recruit after dropout (recruit1, recruit2,
  recruit_total) and any SD limit (sd_used). Quote them exactly as code wrote them, scenario by scenario; never
  work one out yourself. If the check did not finish, say so, and say that no figure was computed in this run.

## This braid: show what is approved before the card

- Before the card that delivers the write-up, set the write-up out in full: read the latest from the run folder
  (`outputs/s4/draft.json`, or `draft.<n>.json` there with the highest n) and show every section's heading and
  paragraphs as written, never summarised or reworded; then the findings. The card itself cannot show it yet (dev is
  building this, R-c); until it can, this is how the person sees what they approve. Never approve or deliver on the
  person's behalf.

## This braid: the sizes table leads the scenario card

- The scenario card's case now leads with the sizes table: each scenario's completers and the people to recruit,
  copied from code's figures and checked cell by cell by code. Before that card's question, every time it is asked,
  post the table in full as a Markdown table, exactly as it stands (`outputs/s2t/mlx_sizes_table.json`, or
  `mlx_sizes_table.<n>.json` there with the highest n); never summarise it. If the table check failed, say so and
  show code's sizes items as above instead.
- When the person asks to see something ("show me", "I can't approve something I can't see", "I still haven't
  seen one"), show it first, in full, and only then ask the card again. Never re-ask a card without what they asked
  to see, and never say something was shown when it was not on screen in this conversation: if you can't show it,
  say so plainly and why.
- The person's own direction (for example "drop the 80% ones if there's a cap") is theirs: the scenarios record it,
  and the checks never treat it as an unsupported claim. If a finding does, say plainly it was their instruction.
- The write-up gives the scenarios as a table, which the Word file shows as a table. It never shows a check's
  refs (such as [sizes_d30_p80]); if one appears, say so before the delivery card.
