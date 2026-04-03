using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class AnthropicProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "Anthropic Messages";
    public string Type => "anthropic";

    public AnthropicProvider(LlmHttpClientFactory httpFactory)
    {
        _httpFactory = httpFactory;
    }

    public async IAsyncEnumerable<StreamEvent> SendMessageAsync(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var requestStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long? firstTokenAt = null;
        var outputTokens = 0;

        var baseUrl = (config.BaseUrl ?? "https://api.anthropic.com").TrimEnd('/');
        var url = $"{baseUrl}/v1/messages";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["x-api-key"] = config.ApiKey,
            ["anthropic-version"] = "2023-06-01",
            ["anthropic-beta"] = "prompt-caching-2024-07-31,interleaved-thinking-2025-05-14"
        };
        if (config.UserAgent is not null)
            headers["User-Agent"] = config.UserAgent;

        ProviderMessageFormatter.ApplyHeaderOverrides(headers, config);
        var bodyBytes = BuildRequestBody(messages, tools, config);

        yield return new StreamEvent
        {
            Type = "request_debug",
            DebugInfo = CreateRequestDebugInfo(url, "POST", headers, bodyBytes, config)
        };

        var client = _httpFactory.GetClient();

        using var response = await SseStreamReader.SendStreamingRequestAsync(
            client, url, "POST", headers, bodyBytes, ct);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct);
            yield return new StreamEvent
            {
                Type = "error",
                Error = new StreamEventError
                {
                    Type = $"http_{(int)response.StatusCode}",
                    Message = $"HTTP {(int)response.StatusCode}: {errorBody[..Math.Min(2000, errorBody.Length)]}"
                }
            };
            yield break;
        }

        await using var stream = await response.Content.ReadAsStreamAsync(ct);

        // Zero-copy SSE parsing: SseItemParser receives ReadOnlySpan<byte>
        var pendingUsage = new TokenUsage();
        var toolBuffers = new Dictionary<int, StringBuilder>();
        var toolCalls = new Dictionary<int, (string Id, string Name)>();

        await foreach (var payload in SseStreamReader.ReadAsync<AnthropicSsePayload>(
            stream,
            static (eventType, data) =>
            {
                if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                    return null;

                return JsonSerializer.Deserialize(data,
                    AppJsonContext.Default.AnthropicSsePayload);
            },
            ct))
        {
            switch (payload.Type)
            {
                case "message_start":
                    var msgUsage = payload.Message?.Usage;
                    if (msgUsage is not null)
                    {
                        pendingUsage.InputTokens = msgUsage.InputTokens ?? 0;
                        if (msgUsage.CacheCreationInputTokens.HasValue)
                            pendingUsage.CacheCreationTokens = msgUsage.CacheCreationInputTokens;
                        if (msgUsage.CacheReadInputTokens.HasValue)
                            pendingUsage.CacheReadTokens = msgUsage.CacheReadInputTokens;
                    }
                    break;

                case "content_block_start":
                {
                    var idx = payload.Index ?? -1;
                    var block = payload.ContentBlock;
                    if (block?.Type == "tool_use" && idx >= 0)
                    {
                        toolBuffers[idx] = new StringBuilder();
                        toolCalls[idx] = (block.Id ?? "", block.Name ?? "");
                        yield return new StreamEvent
                        {
                            Type = "tool_call_start",
                            ToolCallId = block.Id,
                            ToolName = block.Name
                        };
                    }
                    else if (block?.Type == "thinking")
                    {
                        var sig = block.Signature ?? block.EncryptedContent;
                        if (sig is not null)
                        {
                            yield return new StreamEvent
                            {
                                Type = "thinking_encrypted",
                                ThinkingEncryptedContent = sig,
                                ThinkingEncryptedProvider = "anthropic"
                            };
                        }
                    }
                    break;
                }

                case "content_block_delta":
                {
                    firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var idx = payload.Index ?? -1;
                    var delta = payload.Delta;

                    if (delta?.Type == "text_delta")
                    {
                        yield return new StreamEvent { Type = "text_delta", Text = delta.Text };
                    }
                    else if (delta?.Type == "thinking_delta")
                    {
                        yield return new StreamEvent { Type = "thinking_delta", Thinking = delta.Thinking };
                    }
                    else if (delta?.Type == "signature_delta")
                    {
                        var sig = delta.Signature ?? delta.EncryptedContent;
                        if (sig is not null)
                        {
                            yield return new StreamEvent
                            {
                                Type = "thinking_encrypted",
                                ThinkingEncryptedContent = sig,
                                ThinkingEncryptedProvider = "anthropic"
                            };
                        }
                    }
                    else if (delta?.Type == "input_json_delta" && idx >= 0)
                    {
                        if (toolBuffers.TryGetValue(idx, out var buf))
                            buf.Append(delta.PartialJson);

                        var tc = toolCalls.GetValueOrDefault(idx);
                        yield return new StreamEvent
                        {
                            Type = "tool_call_delta",
                            ToolCallId = tc.Id,
                            ArgumentsDelta = delta.PartialJson
                        };
                    }
                    break;
                }

                case "content_block_stop":
                {
                    var idx = payload.Index ?? -1;
                    if (toolCalls.TryGetValue(idx, out var tc))
                    {
                        var raw = toolBuffers.GetValueOrDefault(idx)?.ToString()?.Trim() ?? "";
                        Dictionary<string, JsonElement>? input = null;
                        if (!string.IsNullOrEmpty(raw))
                        {
                        try { input = JsonSerializer.Deserialize(raw, AppJsonContext.Default.DictionaryStringJsonElement); }
                        catch { /* ignore parse failures */ }
                        }

                        yield return new StreamEvent
                        {
                            Type = "tool_call_end",
                            ToolCallId = tc.Id,
                            ToolName = tc.Name,
                            ToolCallInput = input ?? new Dictionary<string, JsonElement>()
                        };

                        toolBuffers.Remove(idx);
                        toolCalls.Remove(idx);
                    }
                    break;
                }

                case "message_delta":
                {
                    var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    if (payload.Usage?.OutputTokens is { } outTok)
                    {
                        pendingUsage.OutputTokens = outTok;
                        outputTokens = outTok;
                    }

                    yield return new StreamEvent
                    {
                        Type = "message_end",
                        StopReason = payload.Delta?.StopReason,
                        Usage = new TokenUsage
                        {
                            InputTokens = pendingUsage.InputTokens,
                            OutputTokens = pendingUsage.OutputTokens,
                            CacheCreationTokens = pendingUsage.CacheCreationTokens,
                            CacheReadTokens = pendingUsage.CacheReadTokens
                        },
                        Timing = new RequestTiming
                        {
                            TotalMs = completedAt - requestStartedAt,
                            TtftMs = firstTokenAt.HasValue ? firstTokenAt.Value - requestStartedAt : null,
                            Tps = ComputeTps(outputTokens, firstTokenAt, completedAt)
                        }
                    };
                    break;
                }

                case "error":
                    yield return new StreamEvent
                    {
                        Type = "error",
                        Error = payload.Error is not null
                            ? new StreamEventError { Type = payload.Error.Type, Message = payload.Error.Message }
                            : null
                    };
                    break;
            }
        }
    }

    private static RequestDebugInfo CreateRequestDebugInfo(string url, string method, Dictionary<string, string> headers, byte[] bodyBytes, ProviderConfig config)
    {
        var maskedHeaders = headers.ToDictionary(
            static pair => pair.Key,
            pair => pair.Key.Equals("x-api-key", StringComparison.OrdinalIgnoreCase)
                ? "***"
                : pair.Value);

        return new RequestDebugInfo
        {
            Url = url,
            Method = method,
            Headers = maskedHeaders,
            Body = Encoding.UTF8.GetString(bodyBytes),
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ProviderId = config.ProviderId,
            ProviderBuiltinId = config.ProviderBuiltinId,
            Model = config.Model,
            ExecutionPath = "sidecar"
        };
    }

    private static byte[] BuildRequestBody(
        List<UnifiedMessage> messages,
        List<ToolDefinition> tools,
        ProviderConfig config)
    {
        var body = new JsonObject
        {
            ["model"] = config.Model,
            ["max_tokens"] = config.MaxTokens ?? 32000,
            ["stream"] = true,
            ["messages"] = ProviderMessageFormatter.FormatAnthropicMessages(messages)
        };

        if (config.SystemPrompt is not null)
        {
            body["system"] = new JsonArray
            {
                new JsonObject
                {
                    ["type"] = "text",
                    ["text"] = config.SystemPrompt,
                    ["cache_control"] = config.EnableSystemPromptCache == true
                        ? new JsonObject { ["type"] = "ephemeral" }
                        : null
                }
            };
        }

        if (config.Temperature.HasValue)
            body["temperature"] = config.Temperature.Value;

        if (config.ThinkingEnabled == true)
        {
            var budget = config.ThinkingConfig?.BodyParams?.TryGetValue("budget_tokens", out var budgetTokens) == true
                && budgetTokens.ValueKind == JsonValueKind.Number
                ? budgetTokens.GetInt32()
                : Math.Min(config.MaxTokens ?? 32000, 32000);
            body["thinking"] = new JsonObject
            {
                ["type"] = "enabled",
                ["budget_tokens"] = budget
            };
        }

        if (tools.Count > 0)
        {
            var toolsArr = new JsonArray();
            foreach (var t in tools)
            {
                toolsArr.Add(new JsonObject
                {
                    ["name"] = t.Name,
                    ["description"] = t.Description,
                    ["input_schema"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: false)
                });
            }
            body["tools"] = toolsArr;
            body["tool_choice"] = new JsonObject { ["type"] = "auto" };
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        return Encoding.UTF8.GetBytes(body.ToJsonString());
    }

    private static double? ComputeTps(int outputTokens, long? firstTokenAt, long completedAt)
    {
        if (firstTokenAt is null || outputTokens <= 1) return null;
        var durationSec = (completedAt - firstTokenAt.Value) / 1000.0;
        return durationSec > 0 ? (outputTokens - 1) / durationSec : null;
    }
}
