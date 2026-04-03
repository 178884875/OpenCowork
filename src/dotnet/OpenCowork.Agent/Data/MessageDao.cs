using Microsoft.Data.Sqlite;

namespace OpenCowork.Agent.Data;

public sealed class MessageDao
{
    private readonly Database _db;

    public MessageDao(Database db) => _db = db;

    public List<Dictionary<string, object?>> GetMessages(string sessionId)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM messages WHERE session_id = @sid ORDER BY sort_order ASC";
        cmd.Parameters.AddWithValue("@sid", sessionId);
        return ReadAll(cmd);
    }

    public List<Dictionary<string, object?>> GetMessagesPage(string sessionId, int limit, int offset)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT * FROM messages WHERE session_id = @sid
            ORDER BY sort_order ASC LIMIT @limit OFFSET @offset
            """;
        cmd.Parameters.AddWithValue("@sid", sessionId);
        cmd.Parameters.AddWithValue("@limit", limit);
        cmd.Parameters.AddWithValue("@offset", offset);
        return ReadAll(cmd);
    }

    public void AddMessage(string id, string sessionId, string role, string content,
        long createdAt, string? usage, int sortOrder)
    {
        var conn = _db.GetConnection();
        using var transaction = conn.BeginTransaction();

        // Check if this is a new row (for message_count update)
        bool isNew;
        using (var checkCmd = conn.CreateCommand())
        {
            checkCmd.Transaction = transaction;
            checkCmd.CommandText = "SELECT session_id FROM messages WHERE id = @id";
            checkCmd.Parameters.AddWithValue("@id", id);
            isNew = checkCmd.ExecuteScalar() is null;
        }

        using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = transaction;
            cmd.CommandText = """
                INSERT OR REPLACE INTO messages (id, session_id, role, content, created_at, usage, sort_order)
                VALUES (@id, @sid, @role, @content, @created_at, @usage, @sort_order)
                """;
            cmd.Parameters.AddWithValue("@id", id);
            cmd.Parameters.AddWithValue("@sid", sessionId);
            cmd.Parameters.AddWithValue("@role", role);
            cmd.Parameters.AddWithValue("@content", content);
            cmd.Parameters.AddWithValue("@created_at", createdAt);
            cmd.Parameters.AddWithValue("@usage", (object?)usage ?? DBNull.Value);
            cmd.Parameters.AddWithValue("@sort_order", sortOrder);
            cmd.ExecuteNonQuery();
        }

        if (isNew)
        {
            using var updateCmd = conn.CreateCommand();
            updateCmd.Transaction = transaction;
            updateCmd.CommandText = """
                UPDATE sessions SET message_count = COALESCE(message_count, 0) + 1,
                    updated_at = @now WHERE id = @sid
                """;
            updateCmd.Parameters.AddWithValue("@now", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            updateCmd.Parameters.AddWithValue("@sid", sessionId);
            updateCmd.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public void UpdateMessage(string id, Dictionary<string, object?> patch)
    {
        if (patch.Count == 0) return;
        var conn = _db.GetConnection();
        var sets = new List<string>();
        using var cmd = conn.CreateCommand();

        foreach (var (key, value) in patch)
        {
            sets.Add($"{key} = @{key}");
            cmd.Parameters.AddWithValue($"@{key}", value ?? DBNull.Value);
        }

        cmd.CommandText = $"UPDATE messages SET {string.Join(", ", sets)} WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public void ClearMessages(string sessionId)
    {
        var conn = _db.GetConnection();
        using var transaction = conn.BeginTransaction();

        using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = transaction;
            cmd.CommandText = "DELETE FROM messages WHERE session_id = @sid";
            cmd.Parameters.AddWithValue("@sid", sessionId);
            cmd.ExecuteNonQuery();
        }

        using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = transaction;
            cmd.CommandText = "UPDATE sessions SET message_count = 0 WHERE id = @sid";
            cmd.Parameters.AddWithValue("@sid", sessionId);
            cmd.ExecuteNonQuery();
        }

        transaction.Commit();
    }

    public int GetMessageCount(string sessionId)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT message_count FROM sessions WHERE id = @sid";
        cmd.Parameters.AddWithValue("@sid", sessionId);
        var result = cmd.ExecuteScalar();
        return result is long l ? (int)l : 0;
    }

    private static List<Dictionary<string, object?>> ReadAll(SqliteCommand cmd)
    {
        using var reader = cmd.ExecuteReader();
        var results = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            results.Add(row);
        }
        return results;
    }
}
