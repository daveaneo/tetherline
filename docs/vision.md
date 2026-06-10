# Tetherline: Product Vision

## The Problem

Code review is broken. Not the mechanical part -- we have GitHub PRs and CI checks for that. What's broken is *understanding*. A team lead reviews a week of commits and misses the forest for the trees. A new hire joins and spends months learning how the pieces fit together. An architect reviews a PR in a subsystem they haven't touched in months and has no spatial memory of where it lives.

We read code in flat lists of diffs. But codebases are spatial, layered, interconnected. Understanding them requires a guided tour from someone who knows the system cold -- someone who can zoom out to the big picture, zoom in to the implementation, and narrate the *why* the whole time.

Tetherline is that someone.

## Why now

AI is writing code faster than any developer can read it, and the gap between you and your own codebase widens by the week. Tetherline is built to bridge that gap. Ask any question and get a quick voice answer — ideally paired with a visual aid that makes the answer obvious, not just heard. The experience should feel **fun, interactive, and intuitive** — not a documentation crawl, not a search box. Talking to the codebase should be the most enjoyable way to learn it.

## What It Is

Tetherline is an AI-powered guided tour of your codebase. You select a repository, choose "Full Walkthrough" or "Updates since last time," and the AI leads you through the code -- narrating what it finds, highlighting architecture diagrams, zooming into relevant files, and responding to your voice in real time.

It is not a tool you operate. It is a guide you converse with.

After the initial repo selection, you never need to touch the keyboard again. You talk. The AI listens. You say "tell me more about that" and it dives deeper. You say "skip this" and it moves on. You ask "why did they use a queue here?" and it answers, then picks up where it left off.

## Progressive Disclosure

This is the core UX principle: never show full complexity. Build understanding one layer at a time. Zoom on demand.

A 500-node codebase doesn't render as 500 nodes. It renders as six boxes: "API Layer," "Auth," "Database," "Background Jobs," "Shared Utils," "Config." That's all you see. The AI narrates what each box does. You say "go deeper on Auth" and Auth expands to reveal its internal modules -- middleware, token management, OAuth providers, session store. Say "go deeper on token management" and you see actual files and functions.

At every level, you see only what matters at that level. The full picture exists, but it's revealed progressively as your understanding grows. The AI manages this zoom -- expanding what it's narrating, collapsing what it's moved past. You can always say "zoom out" to regain the big picture.

This applies to everything, not just diagrams. Code is summarized before it's shown line-by-line. Changes are grouped by significance before individual diffs appear. The AI's narration moves from "what this does" to "how it works" to "why it's built this way" -- each layer deeper than the last.

## The AI's Voice

The guide sounds like a senior engineer who's genuinely happy to walk you through the code. Warm, knowledgeable, unhurried. It uses phrases like "Let me show you..." and "This is interesting because..." and "One thing to note here..." It pauses. It breathes. It doesn't rush.

It never sounds robotic. It never sounds like a bulleted list read aloud. It talks the way a person talks when they know something well and enjoy explaining it. It references spatial context -- "Over on the left you can see the main data flow" -- because the diagram is right there, and a good guide points at things.

The AI is patient. If you stop talking, it waits. After twenty seconds of silence it gently asks: "Want to keep exploring, or shall I continue?" Then it waits again -- indefinitely. It never nags. It never rushes you. Your thinking time is respected.

## The Proposal Moment

After the AI finishes analyzing a repository, it doesn't just start talking. It proposes a plan.

"I found three main areas of change since Tuesday. The biggest is the auth refactor -- they've moved from JWT to session-based tokens and it touches six files. There's also a new caching layer in the API, and some test cleanup. Want to start with the auth refactor, or would you rather go a different direction?"

This is the defining interaction. The AI has done the work of understanding the codebase. Now it presents what it found and invites you to shape the tour. You might say "start with auth" or "actually, tell me about the caching layer first" or "give me the quick version of all three." The AI adapts.

In a Full Walkthrough, the proposal sounds different: "This is a Node.js monorepo with four packages -- a backend, a frontend, a CLI, and shared types. The backend does most of the heavy lifting. Want me to start with the big picture and work down, or is there a specific area you want to see first?"

The tour is a conversation, not a presentation. You shape it.

## Core Design Principles

**Voice-first.** After selecting a repo, everything works by voice. The AI speaks to you. You speak back. The narration bar at the bottom always shows what the AI is saying. Voice input always listens for what you want next.

**It's a guided tour, not a tool.** The AI leads. You steer. Like a museum guide who has a planned route but happily follows when you wander toward something that catches your eye. When you're done exploring, the guide picks up exactly where you left off -- skipping anything you already saw.

**Skills, not commands.** The AI has capabilities -- visualize, explain, compare, critique, summarize, navigate, teach, annotate. But you never invoke them by name. "Show me how this connects to the auth system" triggers visualization. "What do you think of this approach?" triggers critique. The skills are invisible; the conversation is the interface.

## The Room

After selecting a repo, you enter "the room" -- a single persistent space where everything happens. No page navigation. No routing. One canvas, two supporting strips:

**Center: The Architecture Diagram.** The spatial anchor and the primary surface -- it owns the canvas, never shares it side-by-side. As the AI narrates, it highlights, drills, and pulses the nodes being discussed. At the highest level you see five to eight boxes. Say "go deeper on auth" and the view descends into that module; "zoom out" climbs back. Every answer drives the diagram -- it is never static. Code, diffs, and detail views appear as focused overlays on the same canvas and recede when the moment passes.

**Bottom: The Caption + Voice Bar.** A single live line of what the AI is saying (expandable into the full conversation log), with the voice orb and transport controls beneath it. The transcript supports the diagram; it never competes with it.

Everything transitions smoothly. Code morphs between versions with animated token transitions. Diagram nodes expand and contract with spring physics. The room never jump-cuts.

## Two Entry Modes

**Full Walkthrough** builds understanding from zero. The AI starts with what the project does, shows the architecture overview, then guides you through each major component -- narrating as it goes. A first-time repo gets special treatment: "This is our first time looking at this project. Let me start with what it does and how it's built." The AI proposes a tour plan, you shape it, and off you go.

**Updates** keeps you current. A returning user hears: "Welcome back. 12 new commits since Tuesday -- here's what changed." The architecture diagram highlights the areas of change. The AI tours through them in order of significance, explaining what happened and what it means. Your weekly code review in five minutes.

Both modes share the same room, the same voice interaction, and the same deviation model.

## The Understanding Model

Tetherline tracks your understanding across five layers:

1. **Project** -- Do you know what this project does and why?
2. **Architecture** -- Do you know how the major pieces connect?
3. **Component** -- Do you know what each module or service does?
4. **File** -- Have you reviewed the actual code files?
5. **Code** -- Do you understand the logic, not just the structure?

Full Walkthrough fills understanding top-down: project context first, then architecture, then components, then files, then code. Updates fill bottom-up: new code changes first, rippling up to affected components and architecture.

Understanding decays over time. If you reviewed the auth module three months ago but it's changed since, your understanding fades from green to yellow. The AI knows this and prioritizes accordingly.

The understanding map -- a visual treemap colored green, yellow, and red -- serves as both your progress tracker and your entry point. Glance at it and immediately know where your blind spots are.

## Deviation Handling

When you go off-path -- ask a question, request a deep dive, navigate to an unrelated part of the codebase -- the AI tracks exactly where the planned tour was interrupted. When the deviation concludes, it says: "Ready to pick back up? We were looking at the API layer -- I'll skip the auth routes since we already covered those." It resumes minus anything the deviation already covered.

After answering a question or completing a skill, the AI offers a single check-in: "Want to explore more, or shall we keep going?" One prompt, not repeated nagging.

## Who This Is For

**Tech leads and architects** who need to stay current with a codebase growing faster than they can read. Run "Updates" weekly and stay sharp in five minutes.

**New team members** who need to build understanding of an unfamiliar codebase. Run "Full Walkthrough" and get the guided tour that usually takes weeks of reading and asking questions.

**Individual developers** who want to understand subsystems they don't normally work in before making cross-cutting changes.

**Anyone who reviews code** and wants to understand not just *what* changed, but *why*, *how* it connects to everything else, and *whether* it's any good.

## What Exists Today

The foundation is built. The monorepo has a backend (Express + WebSocket + SQLite), a React frontend with architecture diagrams (React Flow), code visualization, voice input and output, and a Claude-powered intelligence layer that clusters commits, generates narration, detects concerns, and builds architecture graphs. The session manager handles state machine navigation. The understanding heatmap tracks file-level familiarity.

What needs to happen next is the transformation from a linear commit-review tool into the guided-tour experience described here: the five-layer understanding model, the skills system, the progressive-zoom diagram, the room layout, the deviation tracker, and the two entry modes.

The soul of the product: code review should feel like having a brilliant colleague walk you through the codebase, narrating as they go, answering your questions, and never losing their place. That's what we're building.
