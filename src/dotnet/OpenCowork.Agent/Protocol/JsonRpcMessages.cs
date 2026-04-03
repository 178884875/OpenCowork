using System.Text.Json;
using System.Text.Json.Serialization;

namespace OpenCowork.Agent.Protocol;

/// <summary>
/// Base envelope for all JSON-RPC 2.0 messages over stdio.
/// Deserialized first to determine whether it is a request, response, or notification.
/// </summary>
public sealed class JsonRpcMessage
{
    [JsonPropertyName("jsonrpc")]
    public string JsonRpc { get; init; } = "2.0";

    [JsonPropertyName("id")]
    public JsonElement? Id { get; init; }

    [JsonPropertyName("method")]
    public string? Method { get; init; }

    [JsonPropertyName("params")]
    public JsonElement? Params { get; init; }

    [JsonPropertyName("result")]
    public JsonElement? Result { get; init; }

    [JsonPropertyName("error")]
    public JsonRpcError? Error { get; init; }

    [JsonIgnore]
    public bool IsRequest => Method is not null && Id is not null;

    [JsonIgnore]
    public bool IsNotification => Method is not null && Id is null;

    [JsonIgnore]
    public bool IsResponse => Method is null && (Result is not null || Error is not null);
}

public sealed class JsonRpcError
{
    [JsonPropertyName("code")]
    public int Code { get; init; }

    [JsonPropertyName("message")]
    public string Message { get; init; } = "";

    [JsonPropertyName("data")]
    public JsonElement? Data { get; init; }
}

/// <summary>
/// Standard JSON-RPC error codes.
/// </summary>
public static class JsonRpcErrorCodes
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;
}

/// <summary>
/// Helper for building outbound JSON-RPC messages.
/// All serialization uses source-generated JsonTypeInfo for AOT safety.
/// </summary>
public static class JsonRpcFactory
{
    public static JsonRpcMessage CreateNotification(string method, object? @params = null)
    {
        return new JsonRpcMessage
        {
            Method = method,
            Params = @params is not null
                ? SerializeToElement(@params)
                : null
        };
    }

    public static JsonRpcMessage CreateRequest(long id, string method, object? @params = null)
    {
        return new JsonRpcMessage
        {
            Id = JsonDocument.Parse(id.ToString()).RootElement.Clone(),
            Method = method,
            Params = @params is not null
                ? SerializeToElement(@params)
                : null
        };
    }

    public static JsonRpcMessage CreateResponse(JsonElement? id, object? result = null)
    {
        return new JsonRpcMessage
        {
            Id = id,
            Result = result is not null
                ? SerializeToElement(result)
                : default(JsonElement?)
        };
    }

    public static JsonRpcMessage CreateErrorResponse(JsonElement? id, int code, string message)
    {
        return new JsonRpcMessage
        {
            Id = id,
            Error = new JsonRpcError { Code = code, Message = message }
        };
    }

    /// <summary>
    /// AOT-safe serialization: serialize to bytes via source gen, then parse into JsonElement.
    /// </summary>
    private static JsonElement SerializeToElement(object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), AppJsonContext.Default);
        using var doc = JsonDocument.Parse(bytes);
        return doc.RootElement.Clone();
    }
}
