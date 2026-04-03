using Microsoft.Data.Sqlite;

namespace OpenCowork.Agent.Data;

public sealed class SessionDao
{
    private readonly Database _db;

    public SessionDao(Database db) => _db = db;

    public List<Dictionary<string, object?>> List()
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM sessions ORDER BY updated_at DESC";
        return ReadAll(cmd);
    }

    public Dictionary<string, object?>? Get(string id)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT * FROM sessions WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        return ReadOne(cmd);
    }

    public void Create(Dictionary<string, object?> session)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO sessions (id, title, icon, mode, created_at, updated_at,
                message_count, project_id, working_folder, ssh_connection_id,
                pinned, plugin_id, provider_id, model_id, long_running_mode)
            VALUES (@id, @title, @icon, @mode, @created_at, @updated_at,
                @message_count, @project_id, @working_folder, @ssh_connection_id,
                @pinned, @plugin_id, @provider_id, @model_id, @long_running_mode)
            """;

        cmd.Parameters.AddWithValue("@id", session.GetValueOrDefault("id") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@title", session.GetValueOrDefault("title") ?? "");
        cmd.Parameters.AddWithValue("@icon", session.GetValueOrDefault("icon") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@mode", session.GetValueOrDefault("mode") ?? "chat");
        cmd.Parameters.AddWithValue("@created_at", session.GetValueOrDefault("createdAt") ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        cmd.Parameters.AddWithValue("@updated_at", session.GetValueOrDefault("updatedAt") ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        cmd.Parameters.AddWithValue("@message_count", session.GetValueOrDefault("messageCount") ?? 0);
        cmd.Parameters.AddWithValue("@project_id", session.GetValueOrDefault("projectId") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@working_folder", session.GetValueOrDefault("workingFolder") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@ssh_connection_id", session.GetValueOrDefault("sshConnectionId") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@pinned", session.GetValueOrDefault("pinned") ?? 0);
        cmd.Parameters.AddWithValue("@plugin_id", session.GetValueOrDefault("pluginId") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@provider_id", session.GetValueOrDefault("providerId") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@model_id", session.GetValueOrDefault("modelId") ?? DBNull.Value);
        cmd.Parameters.AddWithValue("@long_running_mode", session.GetValueOrDefault("longRunningMode") ?? 0);
        cmd.ExecuteNonQuery();
    }

    public void Update(string id, Dictionary<string, object?> patch)
    {
        if (patch.Count == 0) return;
        var conn = _db.GetConnection();
        var sets = new List<string>();
        using var cmd = conn.CreateCommand();

        foreach (var (key, value) in patch)
        {
            var col = CamelToSnake(key);
            sets.Add($"{col} = @{col}");
            cmd.Parameters.AddWithValue($"@{col}", value ?? DBNull.Value);
        }

        if (!patch.ContainsKey("updatedAt"))
        {
            sets.Add("updated_at = @updated_at");
            cmd.Parameters.AddWithValue("@updated_at", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        }

        cmd.CommandText = $"UPDATE sessions SET {string.Join(", ", sets)} WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    public void Delete(string id)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "DELETE FROM sessions WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    private static string CamelToSnake(string camel)
    {
        var chars = new List<char>();
        for (var i = 0; i < camel.Length; i++)
        {
            var c = camel[i];
            if (char.IsUpper(c) && i > 0)
            {
                chars.Add('_');
                chars.Add(char.ToLowerInvariant(c));
            }
            else
            {
                chars.Add(char.ToLowerInvariant(c));
            }
        }
        return new string(chars.ToArray());
    }

    private static List<Dictionary<string, object?>> ReadAll(SqliteCommand cmd)
    {
        using var reader = cmd.ExecuteReader();
        var results = new List<Dictionary<string, object?>>();
        while (reader.Read())
        {
            results.Add(ReadRow(reader));
        }
        return results;
    }

    private static Dictionary<string, object?>? ReadOne(SqliteCommand cmd)
    {
        using var reader = cmd.ExecuteReader();
        return reader.Read() ? ReadRow(reader) : null;
    }

    private static Dictionary<string, object?> ReadRow(SqliteDataReader reader)
    {
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
        {
            var name = reader.GetName(i);
            row[name] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        }
        return row;
    }
}
