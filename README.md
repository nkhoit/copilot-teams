# copilot-teams

Agent teams for GitHub Copilot — coordinate multiple AI agents working together.

Built on the [GitHub Copilot SDK](https://github.com/github/copilot-sdk), this project lets you orchestrate multiple Copilot agent sessions as a collaborating team. Agents communicate via shared channels and direct messages, coordinate on tasks, and can dynamically grow/shrink the team based on workload.

## Prerequisites

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) installed and authenticated
- Node.js 18+

## Quick Start

```bash
npm install
npm test    # Runs M1 test harness — two agents talking to each other
```

## Architecture

```
CopilotClient (single SDK instance)
├── Session "alice" (security researcher)
├── Session "bob"   (backend engineer)
└── ...

Each session gets team coordination tools injected via defineTool():
- team_send()       — post to #general
- team_dm()         — direct message a teammate
- team_get_roster() — see who's on the team
```

## Milestones

- [x] **M1**: Two agents can talk to each other
- [ ] **M2**: Task management (create, claim, complete, dependencies)
- [ ] **M3**: Gateway API (REST + WebSocket)
- [ ] **M4**: Dynamic spawn/despawn with quorum voting
- [ ] **M5**: First client (IRC bridge, web UI, or CLI)

## License

MIT
