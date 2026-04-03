using Microsoft.Data.Sqlite;

namespace OpenCowork.Agent.Data;

public sealed class UsageDao
{
    private readonly Database _db;

    private const string EffectiveInputTokensExpr = """
        COALESCE(
            billable_input_tokens,
            CASE
                WHEN request_type = 'openai-responses'
                    THEN MAX(input_tokens - COALESCE(cache_read_tokens, 0), 0)
                ELSE input_tokens
            END
        )
        """;

    public UsageDao(Database db) => _db = db;

    public void AddEvent(Dictionary<string, object?> evt)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO usage_events (
                id, session_id, message_id, project_id,
                provider_id, provider_name, provider_type, provider_builtin_id, provider_base_url,
                model_id, model_name, request_type,
                input_tokens, output_tokens, billable_input_tokens,
                cache_creation_tokens, cache_read_tokens, reasoning_tokens,
                input_cost_usd, output_cost_usd,
                cache_creation_cost_usd, cache_read_cost_usd, total_cost_usd,
                ttft_ms, total_ms, tps,
                source_kind, source_id,
                request_debug_json, meta_json,
                created_at
            ) VALUES (
                @id, @session_id, @message_id, @project_id,
                @provider_id, @provider_name, @provider_type, @provider_builtin_id, @provider_base_url,
                @model_id, @model_name, @request_type,
                @input_tokens, @output_tokens, @billable_input_tokens,
                @cache_creation_tokens, @cache_read_tokens, @reasoning_tokens,
                @input_cost_usd, @output_cost_usd,
                @cache_creation_cost_usd, @cache_read_cost_usd, @total_cost_usd,
                @ttft_ms, @total_ms, @tps,
                @source_kind, @source_id,
                @request_debug_json, @meta_json,
                @created_at
            )
            """;

        BindParam(cmd, "@id", evt, "id");
        BindParam(cmd, "@session_id", evt, "sessionId");
        BindParam(cmd, "@message_id", evt, "messageId");
        BindParam(cmd, "@project_id", evt, "projectId");
        BindParam(cmd, "@provider_id", evt, "providerId");
        BindParam(cmd, "@provider_name", evt, "providerName");
        BindParam(cmd, "@provider_type", evt, "providerType");
        BindParam(cmd, "@provider_builtin_id", evt, "providerBuiltinId");
        BindParam(cmd, "@provider_base_url", evt, "providerBaseUrl");
        BindParam(cmd, "@model_id", evt, "modelId");
        BindParam(cmd, "@model_name", evt, "modelName");
        BindParam(cmd, "@request_type", evt, "requestType");
        BindParam(cmd, "@input_tokens", evt, "inputTokens", 0);
        BindParam(cmd, "@output_tokens", evt, "outputTokens", 0);
        BindParam(cmd, "@billable_input_tokens", evt, "billableInputTokens");
        BindParam(cmd, "@cache_creation_tokens", evt, "cacheCreationTokens", 0);
        BindParam(cmd, "@cache_read_tokens", evt, "cacheReadTokens", 0);
        BindParam(cmd, "@reasoning_tokens", evt, "reasoningTokens", 0);
        BindParam(cmd, "@input_cost_usd", evt, "inputCostUsd", 0.0);
        BindParam(cmd, "@output_cost_usd", evt, "outputCostUsd", 0.0);
        BindParam(cmd, "@cache_creation_cost_usd", evt, "cacheCreationCostUsd", 0.0);
        BindParam(cmd, "@cache_read_cost_usd", evt, "cacheReadCostUsd", 0.0);
        BindParam(cmd, "@total_cost_usd", evt, "totalCostUsd", 0.0);
        BindParam(cmd, "@ttft_ms", evt, "ttftMs");
        BindParam(cmd, "@total_ms", evt, "totalMs");
        BindParam(cmd, "@tps", evt, "tps");
        BindParam(cmd, "@source_kind", evt, "sourceKind", "chat");
        BindParam(cmd, "@source_id", evt, "sourceId");
        BindParam(cmd, "@request_debug_json", evt, "requestDebugJson");
        BindParam(cmd, "@meta_json", evt, "metaJson");
        BindParam(cmd, "@created_at", evt, "createdAt",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

        cmd.ExecuteNonQuery();
    }

    public Dictionary<string, object?> GetOverview(long? fromMs, long? toMs)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        var (whereClause, _) = BuildWhereClause(cmd, fromMs, toMs);

        cmd.CommandText = $"""
            SELECT
                COUNT(*) as request_count,
                SUM({EffectiveInputTokensExpr}) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_cost_usd) as total_cost_usd,
                AVG(ttft_ms) as avg_ttft_ms,
                AVG(total_ms) as avg_total_ms
            FROM usage_events
            {whereClause}
            """;

        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return new Dictionary<string, object?>();
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return row;
    }

    public List<Dictionary<string, object?>> GetDaily(long? fromMs, long? toMs)
    {
        var conn = _db.GetConnection();
        using var cmd = conn.CreateCommand();
        var (whereClause, _) = BuildWhereClause(cmd, fromMs, toMs);

        cmd.CommandText = $"""
            SELECT
                strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) as request_count,
                SUM({EffectiveInputTokensExpr}) as total_input_tokens,
                SUM(output_tokens) as total_output_tokens,
                SUM(total_cost_usd) as total_cost_usd
            FROM usage_events
            {whereClause}
            GROUP BY day ORDER BY day DESC
            """;

        return ReadAll(cmd);
    }

    private static (string whereClause, int paramCount) BuildWhereClause(
        SqliteCommand cmd, long? fromMs, long? toMs)
    {
        var conditions = new List<string>();
        if (fromMs.HasValue)
        {
            conditions.Add("created_at >= @from");
            cmd.Parameters.AddWithValue("@from", fromMs.Value);
        }
        if (toMs.HasValue)
        {
            conditions.Add("created_at <= @to");
            cmd.Parameters.AddWithValue("@to", toMs.Value);
        }
        var where = conditions.Count > 0
            ? "WHERE " + string.Join(" AND ", conditions)
            : "";
        return (where, conditions.Count);
    }

    private static void BindParam(SqliteCommand cmd, string paramName,
        Dictionary<string, object?> dict, string key, object? defaultValue = null)
    {
        var value = dict.GetValueOrDefault(key) ?? defaultValue;
        cmd.Parameters.AddWithValue(paramName, value ?? DBNull.Value);
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
