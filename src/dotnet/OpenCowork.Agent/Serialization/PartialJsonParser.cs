using System.Text.Json;

namespace OpenCowork.Agent.Serialization;

/// <summary>
/// AOT-safe partial JSON parser for streaming tool argument deltas.
/// Attempts to parse as much of a partial JSON object as possible.
/// </summary>
public static class PartialJsonParser
{
    /// <summary>
    /// Try to parse a (possibly incomplete) JSON object from UTF-8 bytes.
    /// On success, returns the parsed key-value pairs.
    /// On failure (e.g. completely malformed), returns false.
    /// </summary>
    public static bool TryParsePartial(
        ReadOnlySpan<byte> utf8Json,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;
        if (utf8Json.IsEmpty) return false;

        // Fast path: try full parse (convert to ReadOnlyMemory for JsonDocument)
        try
        {
            using var doc = JsonDocument.Parse(new ReadOnlyMemory<byte>(utf8Json.ToArray()));
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;

            result = new Dictionary<string, JsonElement>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
            return true;
        }
        catch (JsonException)
        {
            // Fall through to partial parse
        }

        return TryParseIncomplete(utf8Json, out result);
    }

    /// <summary>
    /// Try to parse a (possibly incomplete) JSON string.
    /// </summary>
    public static bool TryParsePartial(
        string json,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;
        if (string.IsNullOrEmpty(json)) return false;

        // Fast path: try full parse
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;

            result = new Dictionary<string, JsonElement>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
            return true;
        }
        catch (JsonException)
        {
            // Fall through to partial parse
        }

        return TryParseIncompleteString(json, out result);
    }

    private static bool TryParseIncomplete(
        ReadOnlySpan<byte> utf8Json,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;

        if (TryParseClosedCandidate(utf8Json, out result))
            return true;

        for (var len = utf8Json.Length - 1; len > 1; len--)
        {
            if (TryParseClosedCandidate(utf8Json[..len], out result))
                return true;
        }

        return false;
    }

    private static bool TryParseIncompleteString(
        string json,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;

        if (TryParseClosedStringCandidate(json, out result))
            return true;

        for (var len = json.Length - 1; len > 1; len--)
        {
            if (TryParseClosedStringCandidate(json[..len], out result))
                return true;
        }

        return false;
    }

    private static bool TryParseClosedCandidate(
        ReadOnlySpan<byte> candidate,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;
        var closedJson = CloseJson(candidate);
        if (closedJson is null) return false;

        try
        {
            using var doc = JsonDocument.Parse(closedJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;

            result = new Dictionary<string, JsonElement>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
            return result.Count > 0;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool TryParseClosedStringCandidate(
        string candidate,
        out Dictionary<string, JsonElement>? result)
    {
        result = null;
        var closedJson = CloseJsonString(candidate);
        if (closedJson is null) return false;

        try
        {
            using var doc = JsonDocument.Parse(closedJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;

            result = new Dictionary<string, JsonElement>();
            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                result[prop.Name] = prop.Value.Clone();
            }
            return result.Count > 0;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static byte[]? CloseJson(ReadOnlySpan<byte> partial)
    {
        var openBraces = 0;
        var openBrackets = 0;
        var inString = false;
        var escaped = false;

        for (var i = 0; i < partial.Length; i++)
        {
            var b = partial[i];
            if (escaped) { escaped = false; continue; }
            if (b == (byte)'\\') { escaped = true; continue; }
            if (b == (byte)'"') { inString = !inString; continue; }
            if (inString) continue;
            if (b == (byte)'{') openBraces++;
            else if (b == (byte)'}') openBraces--;
            else if (b == (byte)'[') openBrackets++;
            else if (b == (byte)']') openBrackets--;
        }

        if (openBraces < 0 || openBrackets < 0) return null;
        if (!escaped && !inString && openBraces == 0 && openBrackets == 0) return null;

        var suffix = new byte[(escaped ? 1 : 0) + (inString ? 1 : 0) + openBrackets + openBraces];
        var idx = 0;
        if (escaped) suffix[idx++] = (byte)'\\';
        if (inString) suffix[idx++] = (byte)'"';
        for (var i = 0; i < openBrackets; i++) suffix[idx++] = (byte)']';
        for (var i = 0; i < openBraces; i++) suffix[idx++] = (byte)'}';

        var result = new byte[partial.Length + suffix.Length];
        partial.CopyTo(result);
        suffix.CopyTo(result.AsSpan(partial.Length));
        return result;
    }

    private static string? CloseJsonString(string partial)
    {
        var openBraces = 0;
        var openBrackets = 0;
        var inString = false;
        var escaped = false;

        foreach (var ch in partial)
        {
            if (escaped) { escaped = false; continue; }
            if (ch == '\\') { escaped = true; continue; }
            if (ch == '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch == '{') openBraces++;
            else if (ch == '}') openBraces--;
            else if (ch == '[') openBrackets++;
            else if (ch == ']') openBrackets--;
        }

        if (openBraces < 0 || openBrackets < 0) return null;
        if (!escaped && !inString && openBraces == 0 && openBrackets == 0) return null;

        return partial
            + (escaped ? "\\" : string.Empty)
            + (inString ? "\"" : string.Empty)
            + new string(']', openBrackets)
            + new string('}', openBraces);
    }

}
