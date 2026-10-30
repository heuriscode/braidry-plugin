---
name: feedback
description: Send feedback about Heddle to its makers. Use when the person types /heddle:feedback or asks how to give feedback on Heddle.
---

# Heddle feedback

Help the person send feedback on this Heddle tester release. Never include their topic, their prompts, their results or any file contents: only what is listed below.

1. Gather these, and show them to the person as a short block they can copy:
   - **Plugin version:** 0.2.6
   - **Braid:** fairlead.lit_scoping_review@0.4.2
   - **Claude Code version:** run `claude --version` in a shell if you can; otherwise ask the person.
   - **Operating system:** Windows, macOS or Linux.
   - **Run id and practice headline,** if this conversation ran a Heddle braid: the run id (it starts with `run_`) and the "Practice:" line `heddle_deliver` returned. If the run did not finish, say which step it reached and what went wrong, in one sentence of at most 100 characters, without quoting any content.
2. Give them the feedback form: (the link is on its way: your tester invitation will have it)
   - If that is a web address, also give it pre-filled, so they need not paste the block: the address followed by `?block=` and the block, URL-encoded (every character outside `A-Z a-z 0-9 - _ . ~` percent-encoded, line breaks as `%0A`). The form keeps a pre-filled block only if it is 512 characters or fewer before encoding, so if the block is longer, give only the plain address and ask them to paste the block into the first question.
   - Tell them the block shows in the first question and they can edit it before sending.
3. Suggest what is most useful to the Heddle team: what worked, what did not, anything that was confusing, how long it took, and whether they would use the result.
