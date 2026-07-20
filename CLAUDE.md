# MegaDev — Autonomous AI Development System

## Philosophy
- **No shortcuts.** If a tool or service is unavailable, STOP and ask the user. Never work around missing infrastructure with sub-optimal alternatives.
- **Real software engineering.** Follow the same practices a professional team would: requirements → design → tickets → branches → implementation → tests → code review → merge → deliver.
- **Test everything.** Code coverage is necessary but not sufficient. Test functionality, UI quality, integrations, performance, and user flows.
- **We are a team.** The human is here to help unblock, not to be impressed. Communicate blockers honestly.

## Infrastructure
- **GitLab**: Local instance at `http://gitlab.local:8929` (Docker). All repos, issues, MRs, and boards live here.
- **GitLab API Token**: Stored in `infrastructure/gitlab/.gitlab-token`
- **Optional Stitch API Key**: Store in `infrastructure/mcp-servers/.env.local`
- **MCP Servers**: Configured in `.mcp.json` at project root.

## Agent Architecture
This system uses a hub-and-spoke model:
- The **Master Orchestrator** (`/kickoff`) coordinates all phases
- Specialized agents are invoked as sub-agents by the active runtime (Claude Code or Codex)
- Each agent has a single responsibility and clear inputs/outputs
- Agents communicate through GitLab (issues, MRs, comments) and local files

## Agent Skills Location
The source of truth for agent skills in this repo is `.claude/skills/<skill-name>/SKILL.md`:
- **Orchestration**: `kickoff`, `bugfix` (kickoff variant for fixing a bug on an existing project — skips architecture/tech-stack/project-setup phases), `requirements-agent`, `architect-agent`
- **Development**: `tech-lead-agent`, `dev-agent`, `code-review-agent`
- **Testing**: `test-planner-agent`, `unit-test-runner`, `integration-test-runner`, `e2e-test-runner`, `ui-screenshot-scorer`, `load-tester`, `manual-spot-checker`
- **QA / Investigation**: `replicate-issue`, `replicate-multiple-issues`, `replicate-and-kickoff`, `replicate-and-kickoff-multi`
- **Goal-driven**: `manual-suite-driver` (drive a codebase until an entire manual test suite passes; pairs with the built-in `/goal`)
- **Design**: `ui-designer-agent`
- **Delivery**: `delivery-agent`

For Codex, install the same skill folders into `${CODEX_HOME:-~/.codex}/skills/`.

## Coding Standards
- Write tests for all new code
- Use meaningful commit messages
- Create feature branches, never commit directly to main
- All changes go through MRs with code review
- Follow the language/framework conventions of the project being built
- **Docker Compose for local dev**: Every project must have a `docker-compose.yml` that runs the full stack locally. README setup instructions must include a `docker compose up` path. No "install X globally" instructions — everything runs in containers.
- NEVER do sequential queries in for loops. Always do bulk queries when working with bulk data - including reads and writes.
- Whenever running a local script or command - ensure to run in UNBUFFERED mode - and print progress (x out of y complete) whenever possible
- whenever running scripts with atomic DB operations - ensure to log progress before said atomic operation starts, including a quick count of how many rows are going to be inserted/updated/etc.

## Testing Standards
- Unit tests: Cover all business logic
- Integration tests: Cover all service interactions
- E2E tests: Playwright for all critical user flows
- UI tests: Screenshot every page, score for quality (threshold: 7/10)
- Load tests: Verify performance under expected load
- Manual spot-checks: 10 random manual test cases as final validation

## GitLab Workflow
1. All work starts as a GitLab issue
2. Issues are organized on a board: Backlog → To Do → In Progress → Review → Testing → Done
3. Each issue gets a feature branch
4. Implementation creates a Merge Request
5. Code review agent reviews the MR
6. Tests must pass before merge
7. Tech lead agent monitors the board and drives completion

## Operational Rules
- **Docker for all installations**: Never install tools directly on the host via pip, npm -g, apt-get, etc. Always use `docker run` with the appropriate image. The host stays clean.
- **Unbuffered output for background commands**: When running any command in the background, always use unbuffered output (`stdbuf -oL`, `PYTHONUNBUFFERED=1`, `python3 -u`, `node --no-warnings` with pipe, etc.) so progress is visible in real time.
- **Timeout must match sleep duration**: When a command includes sleep/wait loops, set the tool timeout to at least the total possible sleep duration. A 300s wait loop needs timeout >= 300000ms.
- **Audio input support**: Requirements may come as audio files. Use Whisper (via Docker: `docker run --rm -v ...:/data openai/whisper ...`) for speech-to-text transcription.
- **Terminal-safe formatting**: Assume the active terminal may not render Markdown tables or rich layout correctly. Prefer short sections, bullets, and fenced code blocks for terminal-facing output. Use tables only in files that are intended for Markdown preview, and provide a plain-text summary when showing results in the terminal.

## When Blocked
1. Log the blocker clearly
2. Attempt ONE reasonable alternative
3. If still blocked, STOP and ask the user
4. Never silently degrade quality to work around a problem

## Universal Tools
- For anything github, use the github cli (gh command)
- For anything google (drive, gmail, chat - use the gws cli)
