# Braidry for Claude Code (tester release)

Braidry runs **braids**: structured, checked processes that your own Claude carries out, step by step, with every reference checked by code and every claim tested by a separate checker that never sees how the work was made. You make every judgement call. At the end you get your results and a **run record** that says plainly which checks were enforced and which were only asked for.

This tester release has one braid: the **literature scoping review**.

Thank you for testing it. Setting it up takes a few minutes.

## What you need

- **Claude Code**, the terminal version, signed in to your Claude account. Braidry was tested with version 2.1.269. To check yours, open a terminal and type `claude --version`. To update, type `claude update`.
- **Node.js 22 or later.** Braidry's checks run on it. To check, type `node --version`. If you don't have it, install the LTS version from https://nodejs.org.
- **On Windows: Git for Windows** (https://git-scm.com/download/win). Claude Code needs it to install plugins and to run Braidry's hooks.

Braidry does not need a Braidry account, and it sends nothing to Braidry. Everything it makes stays on your computer.

## Install

1. Open a terminal in a folder you want to work in (Braidry keeps each run in a `heddle-runs` folder inside it), and start Claude Code by typing `claude`.
2. Inside Claude Code, type these two commands, one at a time:

   ```
   /plugin marketplace add heuriscode/braidry-plugin
   /plugin install braidry@braidry
   ```

3. If Claude Code says `Run /reload-plugins to apply`, type `/reload-plugins`.

**Had Heddle installed?** The plugin and its marketplace have new names, so remove the old ones first, then install as above:

```
/plugin uninstall heddle@heddle
/plugin marketplace remove heddle
```

Claude Code will show a warning that plugins run with your permissions. That is true of every plugin. Braidry's hooks only watch and, during a run, refuse actions that would break a check; its local server only answers Claude's calls on your computer.

## Run a review

In Claude Code, type:

```
/braidry:review What does the evidence say about <your topic>?
```

Then:

- **Agree the focus.** Claude proposes a research question, scope and what counts as in or out, and asks you to accept or change it.
- **Let it work.** A searcher finds sources, an extractor drafts the review, code checks every citation and quote, and two checkers test the claims and the coverage without seeing how the draft was made.
- **Decide.** Claude shows you what the checkers found and what an adjudicator recommends. You decide what changes.
- **Choose your results.** For example the review in Markdown or as a web page, and the evidence table as a spreadsheet file.

A review takes a while, because each step does real work: our three full test runs took 66 to 72 minutes. You can leave it running and come back when Claude asks you something.

**It uses your Claude usage.** Braidry runs on your own Claude account, and a review is a big job: several helpers each read the sources. On a Pro or Max plan it counts towards your plan's usage limits like any other Claude Code work. If you pay by the token, our three full test runs cost US$9.44 to US$11.40 each at API rates (Sonnet, October 2026).

## What you get

In `heddle-runs/<run id>/`:

- `results/`: the files you chose, such as `review.md` and `evidence.csv`.
- `run_record.json`: the record of the run. Its **practice headline** says, for each check, whether Braidry enforced it, checked it afterwards, or could only ask Claude to follow it. Claude shows you this line at the end.

## Tell us what happened

When you finish (or if something goes wrong), type `/braidry:feedback` in Claude Code. It gathers the plugin version, the run id and the practice headline (never your topic or your results) and gives you the link to the feedback form. Tell us what worked, what didn't, and anything that confused you.

## Update or remove

- To update: `/plugin marketplace update braidry`, then choose **Update now** under `/plugin` > **Installed**.
- To remove: `/plugin uninstall braidry@braidry`.

## Licence

Braidry is licensed under the **PolyForm Shield License 1.0.0** (`LICENSE.md`), a standard licence: you may use it for any purpose, including paid work for clients, except to provide a product that competes with it. What a run produces is yours, and Braidry never receives it. The open-source packages Braidry includes are listed, with their own licences, in `THIRD_PARTY_NOTICES.md`.

## Known limits in this release

- One braid: the literature scoping review.
- Results in Markdown, web page and spreadsheet (CSV) formats. Word output is coming.
- The terminal version of Claude Code. The desktop app and claude.ai are not supported yet.
- Reports, chained braids and team projects are paid features that are not in this release.
