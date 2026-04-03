using System.Buffers;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Text.Json;

namespace OpenCowork.Agent.Protocol;

/// <summary>
/// Zero-copy JSON-RPC 2.0 transport over stdin/stdout using PipeReader/PipeWriter.
/// Messages are newline-delimited JSON (one JSON object per line).
/// </summary>
public sealed class StdioJsonRpcTransport : IAsyncDisposable
{
    private readonly PipeReader _reader;
    private readonly PipeWriter _writer;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _disposed;

    public StdioJsonRpcTransport()
    {
        _reader = PipeReader.Create(Console.OpenStandardInput());
        _writer = PipeWriter.Create(Console.OpenStandardOutput());
    }

    /// <summary>
    /// Reads newline-delimited JSON-RPC messages from stdin.
    /// Deserializes directly from ReadOnlySequence&lt;byte&gt; -- no intermediate string.
    /// </summary>
    public async IAsyncEnumerable<JsonRpcMessage> ReadMessagesAsync(
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        while (!ct.IsCancellationRequested)
        {
            ReadResult result;
            try
            {
                result = await _reader.ReadAsync(ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            var buffer = result.Buffer;

            while (TryReadLine(ref buffer, out var line))
            {
                if (line.Length == 0) continue;

                JsonRpcMessage? msg = null;
                try
                {
                    msg = JsonSerializer.Deserialize(
                        new ReadOnlySpan<byte>(line.ToArray()),
                        AppJsonContext.Default.JsonRpcMessage);
                }
                catch (JsonException ex)
                {
                    await WriteErrorAsync(null, JsonRpcErrorCodes.ParseError,
                        $"JSON parse error: {ex.Message}", ct);
                }

                if (msg is not null)
                    yield return msg;
            }

            _reader.AdvanceTo(buffer.Start, buffer.End);

            if (result.IsCompleted)
                break;
        }
    }

    /// <summary>
    /// Writes a JSON-RPC message to stdout followed by a newline.
    /// Uses Utf8JsonWriter directly to PipeWriter for zero string allocation.
    /// </summary>
    public async ValueTask WriteMessageAsync(JsonRpcMessage message, CancellationToken ct = default)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            var bufferWriter = _writer;
            using var jsonWriter = new Utf8JsonWriter(bufferWriter);
            JsonSerializer.Serialize(jsonWriter, message, AppJsonContext.Default.JsonRpcMessage);
            jsonWriter.Flush();
            bufferWriter.Write("\n"u8);
            await bufferWriter.FlushAsync(ct);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>
    /// Sends a JSON-RPC notification (no id, no response expected).
    /// </summary>
    public ValueTask SendNotificationAsync(string method, object? @params = null,
        CancellationToken ct = default)
    {
        var msg = JsonRpcFactory.CreateNotification(method, @params);
        return WriteMessageAsync(msg, ct);
    }

    /// <summary>
    /// Sends a JSON-RPC response.
    /// </summary>
    public ValueTask SendResponseAsync(JsonElement? id, object? result = null,
        CancellationToken ct = default)
    {
        var msg = JsonRpcFactory.CreateResponse(id, result);
        return WriteMessageAsync(msg, ct);
    }

    /// <summary>
    /// Sends a JSON-RPC error response.
    /// </summary>
    public ValueTask WriteErrorAsync(JsonElement? id, int code, string message,
        CancellationToken ct = default)
    {
        var msg = JsonRpcFactory.CreateErrorResponse(id, code, message);
        return WriteMessageAsync(msg, ct);
    }

    private static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
    {
        var reader = new SequenceReader<byte>(buffer);
        if (reader.TryReadTo(out line, (byte)'\n'))
        {
            buffer = buffer.Slice(reader.Position);
            return true;
        }
        line = default;
        return false;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await _reader.CompleteAsync();
        await _writer.CompleteAsync();
        _writeLock.Dispose();
    }
}
