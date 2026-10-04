# PAI Observability Server

Real-time monitoring dashboard for PAI-OpenCode sessions, providing visibility into tool usage, agent spawning, and session lifecycle.

## Overview

The Observability Server is a lightweight HTTP server that collects and serves telemetry data from PAI-OpenCode sessions. It provides:

- **Real-time event streaming** via Server-Sent Events (SSE)
- **Session tracking** with lifecycle management
- **Tool usage analytics** across all sessions
- **Agent spawn monitoring** for parallel work visibility
- **Historical data** with configurable retention

All data is stored in SQLite with automatic cleanup of old sessions.

## Quick Start

### Prerequisites

- Bun runtime installed
- PAI started with `pai` (OpenCode v2); the core emitter (`pai-core/handlers/observability-emitter.ts`, OpenCode v2 only) posts the events

### Running the Server

```bash
# Development mode (auto-reload on changes)
bun run dev

# Production mode
bun start
```

The server will start on `http://localhost:3001` by default.

### Testing the Server

```bash
# Health check
curl http://localhost:3001/health

# Get current sessions
curl http://localhost:3001/api/sessions

# Stream real-time events
curl -N http://localhost:3001/api/events/stream
```

## API Documentation

### Health Check

```
GET /health
```

Returns server status and uptime.

**Response:**
```json
{
  "status": "ok",
  "uptime": 123.45,
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Session Management

#### List All Sessions

```
GET /api/sessions
```

Returns all active and recent sessions.

**Query Parameters:**
- `limit` (optional): Maximum number of sessions to return (default: 100)

**Response:**
```json
{
  "sessions": [
    {
      "id": "session-123",
      "started_at": "2024-01-01T12:00:00.000Z",
      "ended_at": null,
      "status": "active",
      "tool_count": 5,
      "agent_count": 2
    }
  ]
}
```

#### Get Session Details

```
GET /api/sessions/:sessionId
```

Returns detailed information about a specific session.

**Response:**
```json
{
  "session": {
    "id": "session-123",
    "started_at": "2024-01-01T12:00:00.000Z",
    "ended_at": null,
    "status": "active"
  },
  "tools": [
    {
      "tool": "mcp_bash",
      "args": "{\"command\": \"ls\"}",
      "timestamp": "2024-01-01T12:01:00.000Z",
      "duration_ms": 150
    }
  ],
  "agents": [
    {
      "subagent_type": "Engineer",
      "prompt": "Fix the bug...",
      "timestamp": "2024-01-01T12:02:00.000Z",
      "duration_ms": 5000
    }
  ]
}
```

### Real-time Event Streaming

#### Stream Events (SSE)

```
GET /api/events/stream
```

Opens a Server-Sent Events connection for real-time event streaming.

**Query Parameters:**
- `sessionId` (optional): Filter events for specific session

**Event Types:**

```
event: session_start
data: {"session_id": "session-123", "timestamp": "..."}

event: tool_use
data: {"session_id": "session-123", "tool": "mcp_bash", "duration_ms": 150}

event: agent_spawn
data: {"session_id": "session-123", "subagent_type": "Engineer"}

event: session_end
data: {"session_id": "session-123", "duration_seconds": 300}
```

#### Post Event (Internal)

```
POST /api/events
```

Used by the core emitter (`pai-core/handlers/observability-emitter.ts`, OpenCode v2 only) to post telemetry events.

**Request Body:**
```json
{
  "type": "session_start|tool_use|agent_spawn|session_end",
  "session_id": "session-123",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "data": {
    // Event-specific data
  }
}
```

### Analytics

#### Tool Usage Statistics

```
GET /api/analytics/tools
```

Returns aggregated tool usage statistics.

**Query Parameters:**
- `hours` (optional): Time window in hours (default: 24)

**Response:**
```json
{
  "tools": [
    {
      "tool": "mcp_bash",
      "count": 42,
      "avg_duration_ms": 200,
      "total_duration_ms": 8400
    }
  ]
}
```

#### Agent Spawn Statistics

```
GET /api/analytics/agents
```

Returns aggregated agent spawn statistics.

**Query Parameters:**
- `hours` (optional): Time window in hours (default: 24)

**Response:**
```json
{
  "agents": [
    {
      "subagent_type": "Engineer",
      "count": 5,
      "avg_duration_ms": 5000
    }
  ]
}
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `HOST` | `localhost` | HTTP server host |
| `DATA_DIR` | `./data` | SQLite database directory |
| `RETENTION_HOURS` | `168` | Session retention (7 days) |
| `LOG_LEVEL` | `info` | Logging level |

### Example .env File

```bash
PORT=3001
HOST=localhost
DATA_DIR=./data
RETENTION_HOURS=168
LOG_LEVEL=info
```

## Integration with the PAI core

The Observability Server receives telemetry from the core emitter (`pai-core/handlers/observability-emitter.ts`, OpenCode v2 only), fire-and-forget, at key lifecycle points:

### Event Flow

```
PAI-OpenCode Session Starts
    ↓
emitter: session_start event → POST /api/events
    ↓
Observability Server: Store + Broadcast via SSE
    ↓
Dashboard: Real-time update

User executes tool (mcp_bash, etc.)
    ↓
emitter: tool_use event → POST /api/events
    ↓
Observability Server: Store + Broadcast via SSE
    ↓
Dashboard: Update tool statistics

Agent spawned (Engineer, Architect, etc.)
    ↓
emitter: agent_spawn event → POST /api/events
    ↓
Observability Server: Store + Broadcast via SSE
    ↓
Dashboard: Show parallel work

Session Ends
    ↓
emitter: session_end event → POST /api/events
    ↓
Observability Server: Finalize session + Broadcast
    ↓
Dashboard: Session summary
```

### Plugin Configuration

The emitter reads `PAI_OBSERVABILITY_PORT` (default 8889) and
`PAI_OBSERVABILITY_ENABLED`; see `runbooks/hooksystemet.md`, «Miljøvariabler».

## Data Retention

- Sessions older than `RETENTION_HOURS` are automatically cleaned up
- Cleanup runs every hour
- Deleted sessions include all related tool_use and agent_spawn records (CASCADE)

## Performance Considerations

- SQLite with WAL mode for concurrent reads/writes
- Indexes on `session_id` and `timestamp` columns
- SSE connections are lightweight (one per dashboard)
- Automatic cleanup prevents database bloat

## Troubleshooting

### Server won't start

```bash
# Check if port is already in use
lsof -i :3001

# Try different port
PORT=3002 bun start
```

### No events appearing

1. Verify the session was started with `pai` (not a bare `opencode`) and that `PAI_OBSERVABILITY_PORT` matches the server
2. Check server logs for connection errors
3. Test event posting manually:

```bash
curl -X POST http://localhost:3001/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "type": "session_start",
    "session_id": "test-123",
    "timestamp": "'$(date -Iseconds)'",
    "data": {}
  }'
```

### Database issues

```bash
# Reset database (WARNING: deletes all data)
rm -rf data/*.db*

# Server will recreate schema on next start
bun start
```

## Development

### Project Structure

```
.opencode/observability-server/
├── server.ts           # Main server implementation
├── package.json        # Dependencies
├── README.md          # This file
├── .gitignore         # Ignore data files
└── data/              # SQLite database (gitignored)
    └── observability.db
```

### Adding New Event Types

1. Update event type enum in server.ts
2. Add database columns if needed
3. Emit the new event from `pai-core/handlers/observability-emitter.ts`
4. Update dashboard to display new event

## License

MIT
