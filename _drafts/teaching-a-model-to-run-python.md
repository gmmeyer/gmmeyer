---
title: Teaching a Model to Run Python
dek: A small transformer that executes CPython bytecode, one instruction at a time
date: 2026-10-30
description: A 26M-parameter transformer, trained from scratch on one GPU, that executes CPython bytecode one instruction at a time. It runs in your browser.
---

<!--
  DRAFT v2. Edit this file, not posts/teaching-a-model-to-run-python.html:
  Claude rebuilds the HTML (and the post's line on blog.html) from it. The
  front matter sets the page title, subtitle, date and description.
  Before publishing:
  - "Why did I do this?" is my guess at your reasons. Say it your way.
  - The date is a placeholder: set date: above.
  - Delete this comment and the TODO in "Why did I do this?".
  - The social card (img/og/teaching-a-model-to-run-python.png) isn't rendered
    yet: after setting the date, run python3 _cards/build.py on the Mac (on
    Windows the card's font stack falls back to Segoe UI).
  - Every number here is from the shipped model unless it says otherwise; the
    browser numbers are from running all 600 hand-written scripts through the
    page's own code in Node (web/test/node_run.mjs).
-->

I trained a small transformer to be a Python interpreter. You give it a script, real CPython compiles it to bytecode, and the model runs that bytecode one instruction at a time: it reads the program and the current state of the machine, and writes out the next state. A thin harness takes whatever the model says was printed and puts it on your screen.

Nothing in the loop does the work for it. When your script says `487 // 13`, the model works out 37. When it says `"xo" * 16`, the model writes out all 32 characters, and when it says `s[17]`, the model goes and finds the 18th character.

It runs in your browser: [try it here](../pythonlm/). It only knows integers, loops and strings so far, and it'll tell you if your script uses anything else.

## Why did I do this?

<!-- TODO(Greg): your reasons. My guess at an angle: -->
After [Cicero](building-cicero.html) I wanted the opposite kind of problem. Latin has no answer key: the best I could do was a cloze test and my own eyes. A program's output is right or it's wrong, character for character. And the training data is free and unlimited, because you can generate as many programs as you like and run them to get the answers. So the question was how far a small model, trained from scratch on my 5090, could get at executing real Python exactly.

## How it works

The model doesn't read Python source. Compiling Python is a solved problem, and CPython already does it exactly, so the script goes through the real `compile()` first. What the model learns is execution: given the bytecode listing and the state of the virtual machine (which instruction is next, what's on the value stack, what every variable holds), predict the state after one more instruction, plus anything that instruction printed.

It's a step model, not a trace model. It sees the listing and the current state, never the history, so a script that runs 5,000 instructions needs no more context than one that runs 5.

Everything is tokens from a custom vocabulary of 354: opcodes, digits, one token per character for strings, a handful of structural markers. Here's one real step from `n = 487; q = n // 13; print(q)`, the division itself:

```
<state> ip @0 @0 @5 stack i+ 7 8 4 i+ 3 1 names N0 i+ 7 8 4 </state> =>
<work> i+ 3 7 </work>
<state> ip @0 @0 @6 stack i+ 7 3 names N0 i+ 7 8 4 </state>
```

A few things to notice. Numbers are written least significant digit first (`487` is `i+ 7 8 4`), because that's the order carries happen in for addition and multiplication. Variable names are anonymized (`n` is just `N0`), since what a variable is called never changes what a program does. The instruction pointer gets its own digit tokens, because it's only ever copied or matched against the listing, never computed. And the `<work>` part is scratch space the model writes before the answer, which gets its own section below.

## Refuse, don't guess

The model only knows a subset of Python, so the first thing that happens to any script is a support check: it scans the bytecode and refuses anything outside the subset before running a single step. A clear "I don't support that" beats confidently wrong output.

Then every step goes through two safeguards. Decoding is constrained by a grammar, so the model can't write a malformed state. And a validator checks everything about the new state that follows from the listing alone: the next instruction is a legal successor, the part of the stack below the instruction's operands didn't change, only the variable being assigned changed, a `SWAP` really swapped. If a step fails, the harness resamples, and if every sample fails, the run stops with an error.

What the validator never does is recompute values. It can tell you the model wrote nonsense. It can't tell you the model got the math wrong. That part is all the model.

## The data is free

CPython doesn't let you see its value stack from Python, so I needed my own reference interpreter for the subset, one that records the full machine state after every instruction. A reference interpreter that's subtly wrong would teach the model to be subtly wrong, so every generated script also runs in real CPython with opcode-level tracing, and the two are compared at every single instruction: which instruction ran, every variable's value, and the final output. Any mismatch stops generation. Across tens of millions of scripts, there hasn't been one.

The scripts come from three places: a grammar that writes random programs in the subset, templates of classics (gcd, Fibonacci, FizzBuzz, Collatz, digit sums), and about a thousand "natural" scripts written by Claude in the style people actually write, which the pipeline perturbs into many more. A billion tokens of training data takes about two minutes on 32 cores.

The subset grows in phases, and the bar for each phase is 99% exact output on programs it has never seen:

- **A:** integers, variables, `+ - * // %`, `print()`
- **B:** comparisons, `and`/`or`/`not`, if/elif/else, while, `for` over `range()`, break, continue
- **C:** strings: concatenation, repetition, f-strings, `str()`, `len()`, indexing, printing several things at once with any `sep` and `end`

Lists, functions and dicts come later. Floats are out of scope on purpose: printing a float exactly the way Python does is its own research project.

## The model

It's small: 26 million parameters, 8 layers of width 512, the usual modern parts (RMSNorm, rotary position embeddings, QK-norm, SwiGLU), trained from scratch. Training packs many steps of the same program into one long sequence, where each step can see the program listing and itself but not the other steps, which is exactly what inference with a cached listing looks like. On the 5090 that runs at about 575,000 tokens a second, so a 3-billion-token run takes about an hour and a half. The model in the demo is the end of one long chain of runs, each picking up where the last left off: about 36 billion tokens and 16 hours of training from random weights.

## Division is hard

The first phase A model got 85% of held-out programs exactly right. Nearly everything it got wrong was `//` and `%`. Everything except arithmetic was close to perfect: 5 wrong steps in about 400,000. Addition and subtraction were almost free. Division was a disaster, especially by 6 through 9 (about half wrong) and by 11 and 13 (three quarters wrong).

The reason turned out to be the digit order. Least-significant-first is great for addition, because the first digit you write only depends on the last digits of the inputs. Long division goes the other way: you find the leading digit of the quotient first and the units digit last. I was asking the model to write the units digit first, which means doing all of the long division in its head before emitting a single token. Of 761 wrong `//` answers, 760 were wrong at exactly that first digit, with everything after it right. Doubling the model's depth barely helped (9% fewer errors).

So I tested output formats on division alone, in a small model trained just on `a op b`, which takes minutes instead of hours:

| Output format                                      | `//` error | `%` error |
| -------------------------------------------------- | ---------- | --------- |
| Result, least significant digit first (what I had) | 0.58%      | 2.2%      |
| Result, most significant digit first               | 0.20%      | 13%       |
| Quotient MSB-first as scratch, then the result     | 0.058%     | 0.32%     |
| Same, and `%` also writes divisor × quotient       | 0.064%     | 0.13%     |

Letting the model show its work, writing the quotient in the order you'd actually compute it before giving the answer, cut errors by about 10×. For `%`, also writing out divisor × quotient turns the remainder into plain subtraction. The harness ignores the scratch, but the model needs it. With that format and more division-heavy data, phase A hit **99.81%** exact output on 10,016 held-out programs. Phase B (loops and branches) passed at **99.70%**.

## The test set was lying to me

Those held-out programs came from the same generators as the training data, just never trained on. So I also had a set of hand-written scripts, 200 per phase, written by Claude subagents in styles deliberately unlike the generators and checked so none of them appear in training. The phase A model that passed at 99.81% scored **58.5%** on them.

A held-out split of generated data measures the generator, not the model. Every one of these failures traced back to something the generator never made, or almost never:

- **Labels that look alike.** Long hand-unrolled simulations that print "Round 1", "Round 2", "Round 3". Loading one of them, the model would copy from another. Generated phase A programs were short; these ran up to twice as long as anything in training.
- **More than 10 variables.** The generator used 3 to 10 names per script, so the tokens for the 11th variable onward were never trained. Every hand-written script with more than 10 variables failed.
- **`a, b, c = c, a, b`.** A three-way swap is in 4.5% of the hand-written scripts and 0.01% of the training data.
- **Python idioms people actually use.** `x = a or 7`, chained comparisons like `a < b > c`, `range` with a step of 7, adding up booleans with `n += i > 0`.

None of that is the model failing to generalize, exactly. You can't hold out a pattern your training data never contains. So I wrote a coverage tool that compares how often each kind of step appears in the hand-written scripts versus the training data, and an "edge" generator that makes exactly the things the coverage tool flags. Then I did that over and over: run the hand-written sets, find what's missing, add it to the edge generator, train another round.

| Model                                 | Hand-written A | B         | C         |
| ------------------------------------- | -------------- | --------- | --------- |
| After phase A training                | 58.5%          |           |           |
| After phase B training                | 70.0%          | 91.5%     |           |
| Phase C, edge round 1                 | 88.5%          | 97.0%     | 49.0%     |
| Round 2                               | 97.5%          | 98.0%     | 57.5%     |
| Round 3                               | 95.0%          | 99.0%     | 77.0%     |
| Round 4                               | 99.0%          | 99.0%     | 90.5%     |
| Round 5                               | 97.5%          | 98.5%     | 91.5%     |
| **Rounds 4 and 5 averaged (shipped)** | **99.5%**      | **99.5%** | **93.5%** |

Phases A and B are over the bar on hand-written scripts now. Phase C isn't yet. That last row gets its own section below.

## Strings

The hardest single step in phase C was indexing: `s[i]` means finding the i-th character of a string that could be 48 characters long, which is a lookup the model has to do by position. The first phase C model got it wrong 17% of the time, the second 7%.

Before inventing another scratch format I ran the same kind of small probe. Plain indexing turns out to be perfectly learnable: about 50% wrong after 260,000 examples, 0.016% wrong after 1.3 million. It's a cliff, not a slope. The real model had seen about 200,000 indexing steps in total, because the generator only ever indexed with literals (`s[3]`), while people write `s[i]` inside loops over the string. A "walk" scratch format, where the model spells out characters up to the index, learned faster early on but ended up in the same place, so the fix was more data, not a new format. With loops over string positions added to the edge data, indexing errors went from 3,465 in two million test steps to fewer than 40.

The next gap was things like `print(a, b, sep=" -> ")`: training only ever used six separators, so the model learned those six instead of copying whatever separator the script asked for. Empty strings and fixed-width padding (`" " * (w - len(s)) + s`) were missing the same way.

After that, the failure stats said the biggest group was the validator stopping runs: the model wrote a stack that was one item short. That's a symptom, not a cause, so I replayed the model on each of those steps to see what it actually wrote. Most of them were the same mistake. In `print("both together:", a + b)` the stack holds three strings, and the model glued all three together instead of just the top two. The generator had never put a string expression on top of another string, so the model had never had to find where one string ends and the next begins. Comparisons of near-identical strings (`'xyyxyx' == 'xyxyyx'`) and long repeat counts (`"~" * width` with a width of 27) were missing the same way. Adding those took hand-written phase C from 77% to 90.5%.

## Deciding which model to ship

The next round went after the two biggest groups of failures that were left: comparing near-identical strings, and keeping count of runs of identical things. It went sideways. It fixed nine of the remaining failures, mostly the ones it was aimed at, and broke seven scripts that used to work. It also lost four phase A scripts to division and dropped from 98.6% to 97.4% on generated phase C. It had overcorrected: where earlier models glued strings together that should have stayed apart, this one started splitting strings that should have been one.

In Cicero, averaging the last few checkpoints of a run made things worse. These two models were a different case: the new one was trained starting from the old one, so they're close relatives, and averaging the weights of close relatives is a known trick. It takes seconds to try. The average beat both parents on every test set:

|                             | Round 4 | Round 5 | Average    |
| --------------------------- | ------- | ------- | ---------- |
| Hand-written A              | 99.0%   | 97.5%   | **99.5%**  |
| Hand-written B              | 99.0%   | 98.5%   | **99.5%**  |
| Hand-written C              | 90.5%   | 91.5%   | **93.5%**  |
| Generated C (2,000 scripts) | 98.55%  | 97.35%  | **99.55%** |

So the average is what shipped. It isn't free: it picked up one new mistake from round 5 (it thinks `'A' <= '4'`), which shows up in its step-by-step error on generated scripts but changed what only 2 of 2,000 of them printed.

## What it still gets wrong

The shipped model fails 13 of the 200 hand-written phase C scripts. Some of them:

- A loop that grows `"b"` into `"aaab"` one `"a"` at a time, checking `s == target` each pass. At `"aab"` it says True. String comparisons are still the biggest group, 4 of the 13, and two of those compare a string with an identical one and get it wrong.
- `s = s * -1` should give an empty string. It keeps the 32-character string.
- `print(w1, w2, w3, w4, sep=" ", end=" = ")` comes out as `as = soon = as = possible = `: it used the `end` as the separator.
- Counting: `0 0 0 0 0` with one zero too many, `[][][][]` with one pair too many.

The last round of data took the scripts that fail on a comparison from 8 to 5, but a model that can say `'foobar' == 'foobar'` is False hasn't learned to compare strings. I think they need what division needed: a scratch step where the model writes out where the two strings first differ before giving the answer.

## Getting it into your browser

The demo runs the whole thing on your machine. CPython 3.14, compiled to WebAssembly by the Pyodide project, compiles your script and runs the same harness, in Python, that the training box uses. The model is exported to ONNX (53 MB, weights stored in half precision), hosted on Hugging Face, and runs on ONNX Runtime Web. You can watch the stack and variables change one instruction at a time, next to what real Python prints for the same script.

Two things made that practical. First, the model rewrites the whole machine state at every step, 30 to 45 tokens even when one number changed, and generating those one at a time means 30 to 45 passes through the model per step. But the new state is mostly a copy of the old one, so the page drafts it from the old state and checks the whole draft in a single pass, keeping it only as far as the model agrees with it. The output is exactly what token-by-token decoding would give, in about 5 passes per step.

Second, I had the Cicero problem again: on WebGPU, one ONNX Runtime Web build gave this model garbage logits, off by 25, while the same file was fine on the CPU. Another build of the same library is correct. So the page now runs a self-test before it trusts any backend: a few steps with known answers from the PyTorch model, which have to match exactly. It also turned out that for a model this small, the CPU is about ten times faster than the GPU per pass (7 ms against 70 on my machine), so that's what it usually runs on.

And this time I measured the artifact that ships. The exported model matches PyTorch's choice on every one of 30,447 output tokens I checked it on. Then all 600 hand-written scripts went through the page's own code (Pyodide, the harness, the browser model runtime) in Node. They came out the same as with the PyTorch model on 599 of the 600. The odd one out is a comparison so close to a tie that the browser's half-precision weights tip it the right way, so the demo scores **99.5%** on phase A, **99.5%** on B and **94.0%** on C.

## What I actually learned

1. **Let the model show its work.** A few scratch tokens in the right order did more for division than doubling the model.
2. **Generated test sets grade the generator.** 99.8% on held-out generated programs and 58.5% on hand-written ones, from the same model. Write the hand-written set first.
3. **Measure coverage, not just accuracy.** Every hand-written failure I traced came from a pattern that was rare or absent in training, and counting step kinds found those faster than reading failures.
4. **Look at what the model actually wrote.** "The validator stopped 18 runs" sounds like 18 problems. Replaying the failing steps showed it was mostly one.
5. **Probe in isolation.** A tiny model trained for a few minutes on one operation settled questions (division format, indexing format) that full runs couldn't answer cleanly.
6. **Fixes overshoot.** Drilling a weakness hard enough fixed it and broke its mirror image. Averaging the before and after kept most of the fix.
7. **Exact checkers are a gift.** Because every training example is checked against real CPython at every instruction, I never had to wonder whether the data was wrong.

## Try it

The demo is [here](../pythonlm/). Paste in a script that sticks to integers, loops and strings and watch it run. It's a 26M-parameter model doing long division in its head, so be nice to it.

The code, data pipeline and hand-written test sets are on [GitHub](https://github.com/gmmeyer/pythonlm), and the model is on [Hugging Face](https://huggingface.co/gmmeyer/pythonlm). Lists and functions are next.
