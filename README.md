# Braidry for Claude Code (tester release)

Braidry runs **braids**: structured, checked processes that your own Claude carries out, step by step, with every reference checked by code and every claim tested by a separate checker that never sees how the work was made. You make every judgement call. At the end you get your results and a **run record** that says plainly which checks were enforced and which were only asked for.

This tester release (0.4.1) has four braids:

- **Literature review** (`/braidry:review`): a scoping review of the evidence on your question, with every reference checked by code and every quote matched against the source's text wherever that text could be read.
- **Check my draft** (`/braidry:check-draft`): checks a draft's references, quotes and numbers against the documents it cites, and gives you a corrected draft.
- **Check a client report** (`/braidry:check-client-report`): the same checks for a report going to a client, against its sources and your house style guide.
- **Sample size and power** (`/braidry:sample-size`): how many people a study needs, with every figure computed in code.

Thank you for testing it. Setting it up takes a few minutes.

## What you need

- **Claude Code**, the terminal version, signed in to your Claude account. Braidry was tested with version 2.1.269. To check yours, open a terminal and type `claude --version`. To update, type `claude update`.
- **Node.js 22 or later.** Braidry's checks run on it. To check, type `node --version`. If you don't have it, install the LTS version from https://nodejs.org.
- **On Windows: Git for Windows** (https://git-scm.com/download/win). Claude Code needs it to install plugins and to run Braidry's hooks.

Braidry does not need an account. Everything it makes stays on your computer. You can connect it to a Braidry Online account if you choose, but this release sends nothing from your runs to Braidry Online.

## Install

1. Open a terminal in a folder you want to work in (Braidry keeps each run in a `heddle-runs` folder inside it), and start Claude Code by typing `claude`.
2. Inside Claude Code, type these two commands, one at a time:

   ```
   /plugin marketplace add heuriscode/braidry-plugin
   /plugin install braidry@braidry
   ```

3. If Claude Code says `Run /reload-plugins to apply`, type `/reload-plugins`.

**Already have Braidry 0.4.0?** Update it as described under "Update or remove" below.

**Had Heddle installed?** The plugin and its marketplace have new names, so remove the old ones first, then install as above:

```
/plugin uninstall heddle@heddle
/plugin marketplace remove heddle
```

Claude Code will show a warning that plugins run with your permissions. That is true of every plugin. Braidry's hooks only watch and, during a run, refuse actions that would break a check; its local server only answers Claude's calls on your computer.

## Run a braid

In Claude Code, type the braid's command and say what you need, for example:

```
/braidry:review What does the evidence say about <your topic>?
```

Then:

- **Agree the focus.** Claude proposes what the run will do and asks you to accept or change it.
- **Let it work.** Makers do the work, code checks every reference, quote and number it can, and separate checkers test the result without seeing how it was made.
- **Decide.** Claude shows you what the checks found, and the work itself where you are approving it. You decide what changes.
- **Choose your results.** For example a Word document, Markdown, a web page or a spreadsheet file.

Some braids take a while, because each step does real work. In our test runs of this release (one run of each, on the 0.4.1 build, 3 November 2026, Sonnet; run IDs below), the literature review took 40 minutes, Check my draft 13 minutes, Check a client report 10 minutes and Sample size and power 5 minutes. You can leave a run going and come back when Claude asks you something.

**It uses your Claude usage.** Braidry runs on your own Claude account. On a Pro or Max plan it counts towards your plan's usage limits like any other Claude Code work. If you pay by the token, those test runs cost, at API rates: literature review US$12.83, Check my draft US$2.79, Check a client report US$2.00, and Sample size and power US$1.26.

These figures are measured from one run each, not averages, and your runs will differ with the topic, the files and the model. The runs: literature review `run_01M6GMAY66GD2KX51GNHT1H99B` (2,422 seconds), Check my draft `run_01M6GMB8YJ80027SMMPAZTVV19` (756 seconds), Check a client report `run_01M6GMBJBFXP932XCC5HM0FY35` (585 seconds), Sample size and power `run_01M6GMB92B2VNC5FCF7XWAXNQ1` (321 seconds).

## What you get

In `heddle-runs/<run id>/`:

- `results/`: the files you chose, such as `Literature review.docx` and `evidence.csv`.
- `run_record.json`: the record of the run. Its **practice headline** says, for each check, whether Braidry enforced it, checked it afterwards, or could only ask Claude to follow it. Claude shows you this line at the end.

## Tell us what happened

When you finish (or if something goes wrong), type `/braidry:feedback` in Claude Code. It gathers the plugin version, the run id and the practice headline (never your topic or your results) and gives you the link to the feedback form. Tell us what worked, what didn't, and anything that confused you.

## Update or remove

- To update: `/plugin marketplace update braidry`, then choose **Update now** under `/plugin` > **Installed**.
- To remove: `/plugin uninstall braidry@braidry`.

## Licence

Braidry is licensed under the **PolyForm Shield License 1.0.0** (`LICENSE.md`), a standard licence: you may use it for any purpose, including paid work for clients, except to provide a product that competes with it. What a run produces is yours, and Braidry never receives it. The open-source packages Braidry includes are listed, with their own licences, in `THIRD_PARTY_NOTICES.md`.

## Known limits in this release

- Four braids. More, such as a submissions synthesis, follow in later releases.
- The terminal version of Claude Code. The desktop app and claude.ai are not supported yet.
- Reports, chained braids and team projects are paid features that are not in this release.
