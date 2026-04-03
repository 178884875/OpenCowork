using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Providers;

public sealed class GeminiProvider : ILlmProvider
{
    private readonly LlmHttpClientFactory _httpFactory;

    public string Name => "Google Gemini";
    public string Type => "gemini";

    public GeminiProvider(LlmHttpClientFactory httpFactory)
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

        var baseUrl = (config.BaseUrl ?? "https://generativelanguage.googleapis.com").TrimEnd('/');
        var url = $"{baseUrl}/v1beta/models/{config.Model}:streamGenerateContent?alt=sse&key={config.ApiKey}";

        var headers = new Dictionary<string, string>
        {
            ["Content-Type"] = "application/json"
        };

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
        var outputTokens = 0;
        var emittedThinkingEncrypted = new HashSet<string>(StringComparer.Ordinal);
        var emittedToolCalls = new HashSet<string>(StringComparer.Ordinal);

        await foreach (var chunk in SseStreamReader.ReadAsync<GeminiStreamChunk>(
            stream,
            static (eventType, data) =>
            {
                if (data.IsEmpty || SseStreamReader.IsDoneSentinel(data))
                    return null;

                return JsonSerializer.Deserialize(data,
                    AppJsonContext.Default.GeminiStreamChunk);
            },
            ct))
        {
            if (chunk.Candidates is null || chunk.Candidates.Count == 0) continue;

            var candidate = chunk.Candidates[0];
            var parts = candidate.Content?.Parts;

            if (parts is not null)
            {
                foreach (var part in parts)
                {
                    var thoughtSignature = part.ThoughtSignature ?? part.ThoughtSignatureCompat;
                    if (!string.IsNullOrWhiteSpace(thoughtSignature) && emittedThinkingEncrypted.Add(thoughtSignature))
                    {
                        yield return new StreamEvent
                        {
                            Type = "thinking_encrypted",
                            ThinkingEncryptedContent = thoughtSignature,
                            ThinkingEncryptedProvider = "google"
                        };
                    }

                    if (part.Text is not null)
                    {
                        firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

                        if (part.Thought == true)
                        {
                            yield return new StreamEvent
                            {
                                Type = "thinking_delta",
                                Thinking = part.Text
                            };
                        }
                        else
                        {
                            yield return new StreamEvent
                            {
                                Type = "text_delta",
                                Text = part.Text
                            };
                        }
                    }

                    var functionCall = part.FunctionCall ?? part.FunctionCallCompat;
                    if (functionCall is not null && !string.IsNullOrWhiteSpace(functionCall.Name))
                    {
                        firstTokenAt ??= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        var args = functionCall.Args ?? new Dictionary<string, JsonElement>();
                        var callId = $"{functionCall.Name}:{JsonSerializer.Serialize(args, AppJsonContext.Default.DictionaryStringJsonElement)}";
                        if (!emittedToolCalls.Add(callId))
                            continue;

                        var extraContent = !string.IsNullOrWhiteSpace(thoughtSignature)
                            ? new ToolCallExtraContent
                            {
                                Google = new GoogleToolCallExtraContent
                                {
                                    ThoughtSignature = thoughtSignature
                                }
                            }
                            : null;
                        var argumentsDelta = JsonSerializer.Serialize(args, AppJsonContext.Default.DictionaryStringJsonElement);

                        yield return new StreamEvent
                        {
                            Type = "tool_call_start",
                            ToolCallId = callId,
                            ToolName = functionCall.Name,
                            ToolCallExtraContent = extraContent
                        };

                        yield return new StreamEvent
                        {
                            Type = "tool_call_delta",
                            ToolCallId = callId,
                            ArgumentsDelta = argumentsDelta
                        };

                        yield return new StreamEvent
                        {
                            Type = "tool_call_end",
                            ToolCallId = callId,
                            ToolName = functionCall.Name,
                            ToolCallInput = args,
                            ToolCallExtraContent = extraContent
                        };
                    }
                }
            }

            if (candidate.FinishReason is not null || chunk.UsageMetadata is not null)
            {
                var usage = chunk.UsageMetadata;
                if (usage?.CandidatesTokenCount.HasValue == true)
                    outputTokens = usage.CandidatesTokenCount.Value;

                var completedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                yield return new StreamEvent
                {
                    Type = "message_end",
                    StopReason = candidate.FinishReason,
                    Usage = usage is not null
                        ? new TokenUsage
                        {
                            InputTokens = usage.PromptTokenCount ?? 0,
                            OutputTokens = usage.CandidatesTokenCount ?? 0
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
        return new RequestDebugInfo
        {
            Url = url,
            Method = method,
            Headers = new Dictionary<string, string>(headers),
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
            ["contents"] = ProviderMessageFormatter.FormatGeminiMessages(messages)
        };

        var systemPrompt = config.SystemPrompt ?? messages.FirstOrDefault(m => m.Role == "system")?.GetTextContent();
        if (!string.IsNullOrWhiteSpace(systemPrompt))
        {
            body["systemInstruction"] = new JsonObject
            {
                ["parts"] = new JsonArray
                {
                    new JsonObject
                    {
                        ["text"] = systemPrompt
                    }
                }
            };
        }

        if (tools.Count > 0)
        {
            var funcDecls = new JsonArray();
            foreach (var t in tools)
            {
                funcDecls.Add(new JsonObject
                {
                    ["name"] = t.Name,
                    ["description"] = t.Description,
                    ["parameters"] = ProviderMessageFormatter.NormalizeToolSchema(t.InputSchema, sanitizeForGemini: true)
                });
            }
            body["tools"] = new JsonArray
            {
                new JsonObject { ["functionDeclarations"] = funcDecls }
            };
        }

        body["generationConfig"] = new JsonObject
        {
            ["maxOutputTokens"] = config.MaxTokens ?? 8192
        };

        if (config.Temperature.HasValue)
        {
            ((JsonObject)body["generationConfig"]!)["temperature"] = config.Temperature.Value;
        }

        ProviderMessageFormatter.ApplyRequestOverrides(body, config);
        return Encoding.UTF8.GetBytes(body.ToJsonString());
    }
}
