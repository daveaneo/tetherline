# Future Features

## Team Understanding Dashboard (PM Mode)

A project manager runs Tetherline to track how their entire team understands the codebase.

### Core concept
- Each developer has their own understanding heatmap, built from their review sessions
- The PM gets an aggregate view: who understands what, where the knowledge gaps are, where bus factor is 1
- Knowledge distribution visualization: "Only Alice has reviewed the payment flow in the last month"

### Quizzes & assessments
- After a review session, the AI generates targeted questions about what was covered
- Developers can take quizzes async to prove/deepen understanding
- Results feed back into the understanding heatmap — a quiz pass turns yellow to green
- Spaced repetition: the system resurfaces concepts from weeks ago to test retention

### Collaboration features
- Team review sessions: multiple people watch the same "movie" together, discuss in real-time
- Knowledge transfer mode: pair a developer who understands an area (green) with one who doesn't (red)
- Onboarding path: new hire gets a curated sequence of past sessions to watch, ordered by importance
- "Who should review this PR?" — suggest reviewers based on understanding map overlap with changed areas

### Metrics & reporting
- Understanding debt over time (how much of the codebase is red across the team?)
- Knowledge concentration risk (areas where only 1 person is green)
- Review velocity: how quickly does the team achieve understanding of new code?
- Weekly/monthly digest for engineering leadership

### Integration points
- Slack: weekly understanding report to a channel
- Linear/Jira: link understanding gaps to specific areas of work
- GitHub: "understanding score" as a PR check (does the reviewer actually understand this area?)
- Calendar: auto-schedule review sessions based on understanding decay
