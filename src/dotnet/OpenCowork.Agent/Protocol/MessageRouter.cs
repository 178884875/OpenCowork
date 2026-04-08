using System.Diagnostics;
using System.Text.Json;
using OpenCowork.Agent.Engine;
using OpenCowork.Agent.Tools.Fs;

namespace OpenCowork.Agent.Protocol;

/// <summary>
/// Routes incoming JSON-RPC method calls to the appropriate handler.
/// Handlers are registered at startup; unknown methods return MethodNotFound.
/// </summary>
public sealed class MessageRouter
{
    private readonly StdioJsonRpcTransport _transport;
    private readonly AgentRuntimeService _agentRuntime;
    private readonly Dictionary<string, Func<JsonElement?, JsonElement?, CancellationToken, Task>> _handlers = new();
    private readonly CancellationTokenSource _shutdownCts = new();

    public CancellationToken ShutdownToken => _shutdownCts.Token;

    public MessageRouter(StdioJsonRpcTransport transport)
    {
        _transport = transport;
        _agentRuntime = new AgentRuntimeService(transport, SendRequestAsync);
        RegisterBuiltinHandlers();
    }

    /// <summary>
    /// Register a request handler for a given method.
    /// The handler receives (params, id, ct) and must send a response via the transport.
    /// </summary>
    public void RegisterHandler(string method,
        Func<JsonElement?, JsonElement?, CancellationToken, Task> handler)
    {
        _handlers[method] = handler;
    }

    /// <summary>
    /// Register a simple request handler that returns a result synchronously.
    /// </summary>
    public void RegisterHandler<TResult>(string method,
        Func<JsonElement?, CancellationToken, Task<TResult>> handler)
    {
        _handlers[method] = async (JsonElement? @params, JsonElement? id, CancellationToken ct) =>
        {
            var result = await handler(@params, ct);
            await _transport.SendResponseAsync(id, result, ct);
        };
    }

    /// <summary>
    /// Main message processing loop. Reads from stdin and dispatches.
    /// </summary>
    public async Task RunAsync(CancellationToken ct = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _shutdownCts.Token);

        await foreach (var msg in _transport.ReadMessagesAsync(linked.Token))
        {
            if (msg.IsRequest)
            {
                _ = HandleRequestAsync(msg, linked.Token);
            }
            else if (msg.IsNotification)
            {
                _ = HandleNotificationAsync(msg, linked.Token);
            }
            else if (msg.IsResponse)
            {
                HandleResponse(msg);
            }
        }
    }

    /// <summary>
    /// Sends a request to the Electron side and waits for the response.
    /// Used for approval flow and electron/invoke calls.
    /// </summary>
    public async Task<JsonElement?> SendRequestAsync(string method, object? @params,
        CancellationToken ct, TimeSpan? timeout = null)
    {
        var id = Interlocked.Increment(ref _nextRequestId);
        var tcs = new TaskCompletionSource<JsonElement?>(TaskCreationOptions.RunContinuationsAsynchronously);

        _pendingRequests[id] = tcs;

        var msg = JsonRpcFactory.CreateRequest(id, method, @params);
        await _transport.WriteMessageAsync(msg, ct);

        using var timeoutCts = timeout.HasValue
            ? new CancellationTokenSource(timeout.Value)
            : new CancellationTokenSource(TimeSpan.FromMinutes(10));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

        await using var reg = linked.Token.Register(() =>
        {
            _pendingRequests.TryRemove(id, out _);
            tcs.TrySetCanceled();
        });

        return await tcs.Task;
    }

    private long _nextRequestId;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<long, TaskCompletionSource<JsonElement?>>
        _pendingRequests = new();

    private async Task HandleRequestAsync(JsonRpcMessage msg, CancellationToken ct)
    {
        var method = msg.Method!;
        if (!_handlers.TryGetValue(method, out var handler))
        {
            await _transport.WriteErrorAsync(msg.Id, JsonRpcErrorCodes.MethodNotFound,
                $"Method not found: {method}", ct);
            return;
        }

        try
        {
            await handler(msg.Params, msg.Id, ct);
        }
        catch (OperationCanceledException)
        {
            await _transport.WriteErrorAsync(msg.Id, JsonRpcErrorCodes.InternalError,
                "Request cancelled", CancellationToken.None);
        }
        catch (Exception ex)
        {
            await _transport.WriteErrorAsync(msg.Id, JsonRpcErrorCodes.InternalError,
                ex.Message, CancellationToken.None);
        }
    }

    private Task HandleNotificationAsync(JsonRpcMessage msg, CancellationToken ct)
    {
        var method = msg.Method!;
        if (_handlers.TryGetValue(method, out var handler))
        {
            return handler(msg.Params, null, ct);
        }
        return Task.CompletedTask;
    }

    private void HandleResponse(JsonRpcMessage msg)
    {
        if (msg.Id is not { } idElement) return;
        if (idElement.ValueKind != JsonValueKind.Number) return;

        var id = idElement.GetInt64();
        if (_pendingRequests.TryRemove(id, out var tcs))
        {
            if (msg.Error is not null)
            {
                tcs.TrySetException(new JsonRpcException(msg.Error.Code, msg.Error.Message));
            }
            else
            {
                tcs.TrySetResult(msg.Result);
            }
        }
    }

    private void RegisterBuiltinHandlers()
    {
        RegisterHandler<PongResult>("ping", (JsonElement? @params, CancellationToken ct) =>
        {
            var pong = new PongResult
            {
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Version = Program.Version
            };
            return Task.FromResult(pong);
        });

        RegisterHandler<InitializeResult>("initialize", (JsonElement? @params, CancellationToken ct) =>
        {
            var result = new InitializeResult
            {
                Ok = true,
                Version = Program.Version,
                Capabilities = [.. _agentRuntime.GetCapabilities()]
            };
            return Task.FromResult(result);
        });

        RegisterHandler<CapabilitiesListResult>("capabilities/list", (JsonElement? @params, CancellationToken ct) =>
        {
            return Task.FromResult(new CapabilitiesListResult
            {
                Capabilities = [.. _agentRuntime.GetCapabilities()]
            });
        });

        RegisterHandler<CapabilitiesCheckResult>("capabilities/check", (JsonElement? @params, CancellationToken ct) =>
        {
            var parsed = @params.HasValue
                ? JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.CapabilitiesCheckParams)
                : null;
            var capability = parsed?.Capability ?? string.Empty;
            return Task.FromResult(new CapabilitiesCheckResult
            {
                Capability = capability,
                Supported = _agentRuntime.SupportsCapability(capability)
            });
        });

        RegisterHandler<FsGrepResult>("fs/grep", async (JsonElement? @params, CancellationToken ct) =>
        {
            var parsed = @params.HasValue
                ? JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.FsGrepParams)
                : null;
            if (parsed is null || string.IsNullOrWhiteSpace(parsed.Pattern))
                throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "fs/grep pattern is required");

            var searchTarget = Path.GetFullPath(string.IsNullOrWhiteSpace(parsed.Path) ? "." : parsed.Path);
            if (!Directory.Exists(searchTarget) && !File.Exists(searchTarget))
                throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, $"Search path does not exist: {searchTarget}");

            var stopwatch = Stopwatch.StartNew();
            var result = await GrepTool.SearchAsync(searchTarget, parsed.Pattern, new GrepOptions
            {
                CaseInsensitive = true,
                GlobPatterns = string.IsNullOrWhiteSpace(parsed.Include)
                    ? null
                    : parsed.Include
                        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries),
                MaxResults = parsed.MaxResults,
                MaxLineLength = parsed.MaxLineLength,
                MaxOutputBytes = parsed.MaxOutputBytes,
                TimeoutMs = parsed.TimeoutMs,
                MaxFileSizeBytes = GrepTool.DefaultMaxFileSizeBytes
            }, ct);
            stopwatch.Stop();

            return new FsGrepResult
            {
                Results = result.Matches.Select(static match => new FsGrepMatch
                {
                    File = match.File,
                    Line = match.Line,
                    Text = match.Content
                }).ToList(),
                Truncated = result.Truncated,
                TimedOut = string.Equals(result.LimitReason, "timeout", StringComparison.Ordinal),
                LimitReason = result.LimitReason,
                SearchTime = stopwatch.ElapsedMilliseconds
            };
        });

        RegisterHandler<AgentRunResult>("agent/run", async (JsonElement? @params, CancellationToken ct) =>
        {
            var parsed = @params.HasValue
                ? JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.AgentRunParams)
                : null;
            if (parsed is null)
                throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "agent/run params are required");
            return await _agentRuntime.StartRunAsync(parsed, ct);
        });

        RegisterHandler<AgentCancelResult>("agent/cancel", async (JsonElement? @params, CancellationToken ct) =>
        {
            var parsed = @params.HasValue
                ? JsonSerializer.Deserialize(@params.Value, AppJsonContext.Default.AgentCancelParams)
                : null;
            if (parsed is null)
                throw new JsonRpcException(JsonRpcErrorCodes.InvalidParams, "agent/cancel params are required");
            return await _agentRuntime.CancelRunAsync(parsed);
        });

        _handlers["shutdown"] = async (JsonElement? @params, JsonElement? id, CancellationToken ct) =>
        {
            await _transport.SendResponseAsync(id, new ShutdownResult { Ok = true }, ct);
            _shutdownCts.Cancel();
        };
    }
}

public class JsonRpcException : Exception
{
    public int Code { get; }

    public JsonRpcException(int code, string message) : base(message)
    {
        Code = code;
    }
}
