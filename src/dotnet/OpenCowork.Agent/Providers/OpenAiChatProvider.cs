using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class OpenAiChatProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "OpenAI Chat Completions";
    public string Type => "openai-chat";

    public OpenAiChatProvider(LlmHttpClientFactory httpFactory)
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

        var baseUrl = (config.BaseUrl ?? "https://api.openai.com").TrimEnd('/');
        var url = $"{baseUrl}/v1/chat/completions";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json",
            ["Authorization"] = $"Bearer {config.ApiKey}"
        };
        if (config.UserAgent is not null)
            headers["User-Agent"] = config.UserAgent;
        if (config.Organization is not null)
            headers["OpenAI-Organization"] = config.Organization;
        if (config.Project is not null)
            headers["OpenAI-Project"] = config.Project;
        if (config.ServiceTier is not null)
            headers["service_tier"] = config.ServiceTier;

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

        // Tool call accumulators (by tool call index)
        var toolIds = new Dictionary<int, string>();
        var toolNames = new Dictionary<int, string>();
        var toolArgs = new Dictionary<int, StringBuilder>();
        var toolExtraContents = new Dictionary<int, ToolCallExtraContent>();
        string? lastGoogleThinkingSignature = null;

        await foreach (var chunk in SseStreamReader.ReadAsync<OpenAiChatChunk>(
            stream,
            static (eventType, data) =>
            {
                if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                    return null;

                return JsonSerializer.Deserialize(data,
                    AppJsonContext.Default.OpenAiChatChunk);
            },
            ct))
        {
            if (chunk.Usage is not null)
            {
                outputTokens = chunk.Usage.CompletionTokens ?? 0;
            }

            if (chunk.Choices is null || chunk.Choices.Count == 0) continue;

            var choice = chunk.Choices[0];
            var delta = choice.Delta;

            if (delta is null) continue;

            // Text content
            if (delta.Content is not null)
            {
                firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                yield return new StreamEvent { Type = "text_delta", Text = delta.Content };
            }

            // Reasoning content (thinking)
            if (delta.ReasoningContent is not null)
            {
                firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                yield return new StreamEvent { Type = "thinking_delta", Thinking = delta.ReasoningContent };
            }

            if (!string.IsNullOrWhiteSpace(delta.ReasoningEncryptedContent)
                && delta.ReasoningEncryptedContent != lastGoogleThinkingSignature)
            {
                lastGoogleThinkingSignature = delta.ReasoningEncryptedContent;
                yield return new StreamEvent
                {
                    Type = "thinking_encrypted",
                    ThinkingEncryptedContent = delta.ReasoningEncryptedContent,
                    ThinkingEncryptedProvider = "google"
                };
            }

            // Tool calls
            if (delta.ToolCalls is not null)
            {
                foreach (var tc in delta.ToolCalls)
                {
                    firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    var idx = tc.Index;

                    var extraContent = tc.ExtraContent ?? (tc.ExtraContent is null && !string.IsNullOrWhiteSpace(lastGoogleThinkingSignature)
                        ? new ToolCallExtraContent
                        {
                            Google = new GoogleToolCallExtraContent
                            {
                                ThoughtSignature = lastGoogleThinkingSignature
                            }
                        }
                        : null);

                    if (extraContent is not null)
                    {
                        toolExtraContents[idx] = extraContent;
                        if (extraContent.Google?.ThoughtSignature is { Length: > 0 } thoughtSignature
                            && thoughtSignature != lastGoogleThinkingSignature)
                        {
                            lastGoogleThinkingSignature = thoughtSignature;
                            yield return new StreamEvent
                            {
                                Type = "thinking_encrypted",
                                ThinkingEncryptedContent = thoughtSignature,
                                ThinkingEncryptedProvider = "google"
                            };
                        }
                    }

                    if (tc.Id is not null)
                    {
                        toolIds[idx] = tc.Id;
                        toolNames[idx] = tc.Function?.Name ?? "";
                        toolArgs[idx] = new StringBuilder();

                        yield return new StreamEvent
                        {
                            Type = "tool_call_start",
                            ToolCallId = tc.Id,
                            ToolName = tc.Function?.Name,
                            ToolCallExtraContent = toolExtraContents.GetValueOrDefault(idx)
                        };
                    }

                    if (tc.Function?.Arguments is not null)
                    {
                        if (toolArgs.TryGetValue(idx, out var buf))
                            buf.Append(tc.Function.Arguments);

                        yield return new StreamEvent
                        {
                            Type = "tool_call_delta",
                            ToolCallId = toolIds.GetValueOrDefault(idx),
                            ArgumentsDelta = tc.Function.Arguments
                        };
                    }
                }
            }

            // Finish reason
            if (choice.FinishReason is not null)
            {
                // Flush tool calls
                foreach (var (idx, id) in toolIds)
                {
                    var raw = toolArgs.GetValueOrDefault(idx)?.ToString()?.Trim() ?? "";
                    Dictionary<string, JsonElement>? input = null;
                    if (!string.IsNullOrEmpty(raw))
                    {
                        try { input = JsonSerializer.Deserialize(raw, AppJsonContext.Default.DictionaryStringJsonElement); }
                        catch { /* ignore */ }
                    }

                    yield return new StreamEvent
                    {
                        Type = "tool_call_end",
                        ToolCallId = id,
                        ToolName = toolNames.GetValueOrDefault(idx),
                        ToolCallInput = input ?? new Dictionary<string, JsonElement>(),
                        ToolCallExtraContent = toolExtraContents.GetValueOrDefault(idx)
                    };
                }
                toolIds.Clear();
                toolNames.Clear();
                toolArgs.Clear();
                toolExtraContents.Clear();

                var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                yield return new StreamEvent
                {
                    Type = "message_end",
                    StopReason = choice.FinishReason,
                    Usage = chunk.Usage is not null
                        ? new TokenUsage
                        {
                            InputTokens = chunk.Usage.PromptTokens ?? 0,
                            OutputTokens = chunk.Usage.CompletionTokens ?? 0
                        }
                        : null,
                    Timing = new RequestTiming
                    {
                        TotalMs = completedAt - requestStartedAt,
                        TtftMs = firstTokenAt.HasValue ? firstTokenAt.Value - requestStartedAt : null,
                        Tps = outputTokens > 1 && firstTokenAt.HasValue
                            ? (outputTokens - 1) / ((completedAt - firstTokenAt.Value) / 1000.0)
                            : null
                    }
                };
            }
        }
    }

    private static RequestDebugInfo CreateRequestDebugInfo(string url, string method, Dictionary<string, string> headers, byte[] bodyBytes, ProviderConfig config)
    {
        var maskedHeaders = headers.ToDictionary(
            static pair => pair.Key,
            pair => pair.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
                ? "Bearer ***"
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
            ["messages"] = ProviderMessageFormatter.FormatOpenAiChatMessages(messages, config.SystemPrompt, config),
            ["stream"] = true,
            ["stream_options"] = new JsonObject { ["include_usage"] = true }
        };

        if (tools.Count > 0)
        {
            var toolsArr = new JsonArray();
            foreach (var t in tools)
            {
                toolsArr.Add(new JsonObject
                {
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = t.Name,
                        ["description"] = t.Description,
                        ["parameters"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: false)
                    }
                });
            }
            body["tools"] = toolsArr;
            body["tool_choice"] = "auto";
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        return Encoding.UTF8.GetBytes(body.ToJsonString());
    }
}
