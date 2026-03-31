# Interactive Reviewer: Product Vision

## The Problem

Code review is broken. Not the mechanical part -- we have GitHub PRs and CI checks for that. What's broken is *understanding*. A team lead reviews a week of commits and misses the forest for the trees. A new hire joins and spends months just learning how the pieces fit together. An architect reviews a PR in a subsystem they haven't touched in months and has no spatial memory of where it lives.

We read code in flat lists of diffs. But codebases are spatial, layered, interconnected. Understanding them requires the kind of guided tour you'd get from a colleague who knows the system cold -- someone who can zoom out to show you the big picture, zoom in to show you the implementation, and narrate the *why* the whole time.

Interactive Reviewer is that colleague.

## What It Is

Interactive Reviewer is an AI-powered guided tour of your codebase. You select a repository, choose "Full Walkthrough" or "Updates since last time," and the AI leads you through the code -- narrating what it finds, highlighting architecture diagrams, zooming into relevant files, and responding to your voice in real time.

It is not a tool you operate. It is a guide you converse with.

After the initial repo selection, you never need to touch the keyboard again. You talk. The AI listens. You say "tell me more about that" and it dives deeper. You say "skip this" and it moves on. You ask "why did they use a queue here?" and it answers, then picks up where it left off. The interface responds to your words and the AI responds to your intent.

## Core Design Principles

**Don't overwhelm.** The AI never shows full complexity at once. Understanding is built one layer at a time through progressive disclosure. You see five to eight high-level boxes before you see a single line of code.

**Voice-first.** After selecting a repo, everything works by voice. The AI speaks to you. You speak back. The narration bar at the bottom always shows what the AI is saying. Voice input always listens for what you want next.

**It's a guided tour, not a tool.** The AI leads. You steer. Like a museum guide who has a planned route but happily follows when you wander toward something that catches your eye. When you're done exploring, the guide picks up exactly where you left off -- skipping anything you already saw.

**Skills, not commands.** The AI has capabilities -- visualize, explain, compare, critique, summarize, navigate, teach, and more. But you never invoke them by name. You just talk naturally. "Show me how this connects to the auth system" triggers visualization. "What do you think of this approach?" triggers critique. "Compare this to the old implementation" triggers a side-by-side diff. The skills are invisible; the conversation is the interface.

## The Room

After selecting a repo, you enter "the room" -- a single persistent space where everything happens. No page navigation. No routing. The room has three zones:

**Left: The Architecture Diagram.** This is the spatial anchor. It's always visible. As the AI narrates, it zooms in, highlights, and morphs. At the highest level you see five to eight boxes representing the major parts of the system. Say "go deeper" on any box and it expands to reveal its internals. Go deeper again and you see actual files and code structures. The diagram breathes with the narration -- it is never static.

**Right: The Content Panel.** This is where code, diffs, comparisons, and details appear. It adapts to whatever the AI's current skill requires: a syntax-highlighted code snippet, a side-by-side diff, a dependency list, or an explanation with inline code references. The content panel never replaces the diagram -- they work in parallel.

**Bottom: The Narration Bar.** Subtitles of what the AI is saying, always visible, always current. Above it, the voice input indicator pulses gently when listening.

Everything in the room transitions smoothly. Code morphs between versions using animated token transitions. Diagram nodes expand and contract with spring physics. The room never jump-cuts.

## Two Entry Modes

**Full Walkthrough** is for building understanding from zero. The AI starts with what the project does and why it exists, shows the architecture overview, then guides you through each major component -- one at a time, narrating as it goes. It's how you onboard onto a new codebase or refresh your understanding of one you've been away from.

**Updates** is for staying current. The AI says "12 commits since last time -- here's what changed." The architecture diagram highlights the areas of change. The AI tours through them in order of significance, explaining what happened and what it means. It's your weekly code review in five minutes.

Both modes share the same room, the same voice interaction, and the same deviation model.

## The Understanding Model

Interactive Reviewer tracks your understanding across five layers:

1. **Project** -- Do you know what this project does and why?
2. **Architecture** -- Do you know how the major pieces connect?
3. **Component** -- Do you know what each module or service does?
4. **File** -- Have you reviewed the actual code files?
5. **Code** -- Do you understand the logic, not just the structure?

Each layer is tracked independently with a completion percentage. Full Walkthrough fills understanding top-down: project context first, then architecture, then components, then files, then code. Updates fill bottom-up: new code changes first, rippling up to affected components and architecture.

Understanding decays over time. If you reviewed the auth module three months ago but it's changed since, your understanding fades from green to yellow. The AI knows this and prioritizes accordingly.

The understanding map -- a visual treemap of your codebase colored green, yellow, and red -- serves as both your progress tracker and your entry point. Glance at it and immediately know where your blind spots are.

## The AI Skills System

The AI has a growing library of skills, each producing a specific visual output. But the user never sees this machinery. They just talk.

**Visualize** generates diagrams on demand. "Show me the data flow for user registration" produces a focused flow diagram in the content panel while the architecture diagram highlights the relevant components.

**Explain** narrates with synchronized visuals. This is the default skill during a walkthrough -- the AI talks, the diagram highlights, and relevant code appears.

**Compare** shows before-and-after with animated diffs. "How did the error handling change?" morphs the old code into the new code, token by token.

**Critique** gives the AI's opinion. "What do you think of the test coverage here?" produces an honest assessment with specific file references.

**Summarize** condenses. "Give me the one-minute version of this module" produces a simplified diagram and a brief narration.

**Navigate** moves through the codebase. "Go to the database layer" zooms the diagram and shifts focus. "Zoom out" returns to the high-level view.

**Teach** explains concepts. "What's the event sourcing pattern they're using here?" teaches the concept in context, referencing the actual code.

**Annotate** marks things for later. "Flag this for the team" or "I want to come back to this" creates persistent annotations.

New skills can be added over time without changing the user experience. The conversation remains the interface.

## Deviation Handling

When a user goes off-path -- asks a question, requests a deep dive, or navigates to an unrelated part of the codebase -- the AI tracks exactly where the planned tour was interrupted. When the deviation concludes, the AI says something like "Ready to pick back up? We were looking at the API layer -- I'll skip the auth routes since we already covered those." It resumes the tour minus anything the deviation already covered.

If the user is silent for twenty seconds, the AI gently asks: "Want to keep exploring, or shall I continue the walkthrough?" Then it waits patiently. No nagging, no countdown.

## Who This Is For

**Tech leads and architects** who need to stay current with a codebase that's growing faster than they can read. Run "Updates" weekly and stay sharp in five minutes.

**New team members** who need to build understanding of an unfamiliar codebase. Run "Full Walkthrough" and get the guided tour that usually takes weeks of reading and asking questions.

**Individual developers** who want to understand subsystems they don't normally work in before making cross-cutting changes.

**Anyone who reviews code** and wants to understand not just *what* changed, but *why* it changed, *how* it connects to everything else, and *whether* it's any good.

## What Exists Today

The foundation is built. The monorepo has a backend (Express + WebSocket + SQLite), a React frontend with architecture diagrams (React Flow), code visualization, voice input and output, and a Claude-powered intelligence layer that clusters commits, generates narration scripts, detects concerns, and builds architecture graphs. The session manager handles state machine navigation. The understanding heatmap tracks file-level familiarity.

What needs to happen next is the transformation from a linear commit-review tool into the guided-tour experience described here: the five-layer understanding model, the skills system, the progressive-zoom architecture diagram, the room layout, the deviation tracker, and the two entry modes.

The soul of the product is this: code review should feel like having a brilliant colleague walk you through the codebase, narrating as they go, answering your questions, and never losing their place. That's what we're building.
