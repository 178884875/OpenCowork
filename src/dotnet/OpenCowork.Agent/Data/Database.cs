using Microsoft.Data.Sqlite;

namespace OpenCowork.Agent.Data;

/// <summary>
/// SQLite database manager using Microsoft.Data.Sqlite (AOT-compatible).
/// WAL mode for concurrent reads, foreign keys enabled.
/// </summary>
public sealed class Database : IDisposable
{
    private readonly string _connectionString;
    private SqliteConnection? _connection;
    private bool _disposed;

    public Database(string dbPath)
    {
        var dir = Path.GetDirectoryName(dbPath);
        if (dir is not null && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = dbPath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared
        }.ToString();
    }

    public SqliteConnection GetConnection()
    {
        if (_connection is not null && _connection.State == System.Data.ConnectionState.Open)
            return _connection;

        _connection = new SqliteConnection(_connectionString);
        _connection.Open();

        using var pragmaCmd = _connection.CreateCommand();
        pragmaCmd.CommandText = "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;";
        pragmaCmd.ExecuteNonQuery();

        return _connection;
    }

    public void Initialize()
    {
        var conn = GetConnection();
        RunMigrations(conn);
    }

    private static void RunMigrations(SqliteConnection conn)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'chat',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                working_folder TEXT,
                pinned INTEGER DEFAULT 0,
                icon TEXT,
                plugin_id TEXT,
                external_chat_id TEXT,
                plan_id TEXT,
                provider_id TEXT,
                model_id TEXT,
                ssh_connection_id TEXT,
                project_id TEXT,
                long_running_mode INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                usage TEXT,
                sort_order INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_messages_session
                ON messages(session_id, sort_order);

            CREATE INDEX IF NOT EXISTS idx_sessions_plugin
                ON sessions(plugin_id);

            CREATE INDEX IF NOT EXISTS idx_sessions_external_chat
                ON sessions(external_chat_id);

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                working_folder TEXT,
                ssh_connection_id TEXT,
                plugin_id TEXT,
                pinned INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_projects_plugin
                ON projects(plugin_id);

            CREATE INDEX IF NOT EXISTS idx_sessions_project
                ON sessions(project_id);

            CREATE TABLE IF NOT EXISTS plans (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                plan_id TEXT,
                session_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                session_id TEXT,
                message_id TEXT,
                project_id TEXT,
                provider_id TEXT,
                provider_name TEXT,
                provider_type TEXT,
                provider_builtin_id TEXT,
                provider_base_url TEXT,
                model_id TEXT,
                model_name TEXT,
                request_type TEXT,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                billable_input_tokens INTEGER,
                cache_creation_tokens INTEGER DEFAULT 0,
                cache_read_tokens INTEGER DEFAULT 0,
                reasoning_tokens INTEGER DEFAULT 0,
                input_cost_usd REAL DEFAULT 0,
                output_cost_usd REAL DEFAULT 0,
                cache_creation_cost_usd REAL DEFAULT 0,
                cache_read_cost_usd REAL DEFAULT 0,
                total_cost_usd REAL DEFAULT 0,
                ttft_ms INTEGER,
                total_ms INTEGER,
                tps REAL,
                source_kind TEXT DEFAULT 'chat',
                source_id TEXT,
                request_debug_json TEXT,
                meta_json TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_usage_events_created_at
                ON usage_events(created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created_at
                ON usage_events(provider_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_events_model_created_at
                ON usage_events(model_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_events_session_created_at
                ON usage_events(session_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_events_source_kind
                ON usage_events(source_kind);

            CREATE TABLE IF NOT EXISTS draw_runs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                prompt TEXT NOT NULL DEFAULT '',
                result_url TEXT,
                result_base64 TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            """;
        cmd.ExecuteNonQuery();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _connection?.Close();
        _connection?.Dispose();
    }
}
