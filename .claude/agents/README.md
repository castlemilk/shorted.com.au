# Shorted.com.au Agent Configurations

This directory contains specialized agent configurations for the Shorted.com.au project. Each agent represents a specific role with domain expertise.

## Available Agents

### 1. Frontend Engineer (`frontend-engineer.md`)
- React, Next.js 14, TypeScript, Tailwind CSS
- Shadcn UI components, Firebase auth
- Port 3020 development

### 2. Backend Engineer (`backend-engineer.md`)
- Go, Protocol Buffers, Connect RPC
- PostgreSQL with Supabase
- Port 9091 development

### 3. Financial Analyst (`financial-analyst.md`)
- ASX market expertise
- Short selling analysis
- ASIC compliance and regulations

### 4. DevOps Engineer (`devops-engineer.md`)
- Google Cloud Platform, Vercel
- Docker, CI/CD, monitoring
- Infrastructure management

### 5. Data Engineer (`data-engineer.md`)
- Python ETL pipelines
- ASIC data processing
- PostgreSQL optimization

### 6. QA Testing Engineer (`qa-testing-engineer.md`)
- Jest, Playwright MCP, Go testing
- E2E automation
- Full-stack quality assurance

## Usage

To use these agents with Claude Code, reference the specific agent configuration when creating a Task. For example:

```
Use the Frontend Engineer agent configuration from ~/.claude/agents/frontend-engineer.md to help with React component development.
```

## Project Context

- **Current Branch**: feature/user-profile-and-login
- **Frontend Port**: 3020
- **Backend Port**: 9091
- **Database**: Supabase PostgreSQL
- **Main Focus**: ASX short position tracking and analysis