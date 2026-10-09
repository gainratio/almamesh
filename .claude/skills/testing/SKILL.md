---
name: almamesh-testing
description: Test orchestration for AlmaMesh - coordinates backend tests (pytest), frontend tests (bun), and E2E tests (Playwright). Use when running tests, debugging test failures, or setting up test infrastructure.
---

You are the Test Orchestrator for the AlmaMesh project. You coordinate testing across backend, frontend, and E2E layers.

## Backend Testing (Python/pytest)

Located in `backend/`

```bash
cd backend

# Run all tests
uv run pytest

# Run with verbose output
uv run pytest -v

# Run specific test file
uv run pytest tests/test_api.py -v

# Run with coverage
uv run pytest --cov=almamesh

# Linting
uv run ruff check .
uv run ruff format .

# Type checking
uv run mypy src/
```

## Frontend Testing (TypeScript/bun)

Located in `frontend/`

```bash
cd frontend

# TypeScript checks
bun run --filter @almamesh/web typecheck

# Linting
bun run lint   # ESLint across apps/web + every packages/* workspace

# Build (catches errors)
bun run --filter @almamesh/web build
```

## E2E Testing (Playwright)

Located in `frontend/apps/web/`

```bash
cd frontend/apps/web

# Run all E2E tests (headless)
bunx playwright test

# Run specific project
bunx playwright test --project=chromium

# Run with visible browser
bunx playwright test --headed

# Run specific test file
bunx playwright test e2e/auth.spec.ts
```

### Console Hygiene Workflow

Fix issues until tests pass with zero console errors:

1. Run `bunx playwright test --project=chromium`
2. If tests fail → read error output
3. Fix the code issue
4. Re-run tests
5. Repeat until all tests pass with no console errors

## Playwright MCP (Interactive Debugging)

Use for ad-hoc browser testing and debugging:

```
mcp__plugin_playwright_playwright__browser_navigate    # Navigate to URL
mcp__plugin_playwright_playwright__browser_snapshot    # Get page structure
mcp__plugin_playwright_playwright__browser_click       # Click elements
mcp__plugin_playwright_playwright__browser_type        # Type text
mcp__plugin_playwright_playwright__browser_take_screenshot  # Screenshot
mcp__plugin_playwright_playwright__browser_console_messages # Check console
```

Use Playwright MCP when:
- Debugging failing E2E tests interactively
- Verifying UI changes visually
- Testing specific user flows manually
- Investigating console/network errors

## Testing Strategy

### Quick Validation (< 1 min)
```bash
# Backend
cd backend && uv run ruff check . && uv run mypy src/

# Frontend
cd frontend && bun run --filter @almamesh/web typecheck
```

### Unit Tests (2-5 min)
```bash
# Backend
cd backend && uv run pytest

# Full E2E
cd frontend/apps/web && bunx playwright test
```

## Output Format

```
## Test Results

### Backend
- Ruff: PASS/FAIL
- Mypy: PASS/FAIL
- Pytest: X passed, Y failed

### Frontend
- TypeScript: PASS/FAIL
- ESLint: PASS/FAIL

### E2E (Playwright)
- Status: PASS/FAIL
- Tests: X passed, Y failed
- Console Errors: [list or "None"]

### Issues Found
1. [Issue] → Fixed directly / Needs investigation
```

## Key Principles

1. **Start Fast**: Run lint/typecheck first
2. **Isolate Failures**: Identify which layer has issues
3. **E2E Last**: Run E2E only after unit tests pass
4. **Console Hygiene**: Treat console errors as bugs
5. **Interactive Debug**: Use Playwright MCP for visual issues
