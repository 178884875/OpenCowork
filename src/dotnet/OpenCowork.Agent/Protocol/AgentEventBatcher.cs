using System.Text.Json;
using OpenCowork.Agent.Engine;

namespace OpenCowork.Agent.Protocol;

/// <summary>
/// Batches high-frequency agent events (text_delta, thinking_delta, tool_use_args_delta)
/// into periodic flushes to reduce cross-process JSON-RPC message frequency.
/// Boundary events trigger an immediate flush before being sent individually.
/// </summary>
public sealed class AgentEventBatcher : IAsyncDisposable
{
    private const int SizeThresholdChars = 512;
    private static readonly TimeSpan FlushInterval = TimeSpan.FromMilliseconds(33);

    private readonly Func<string, IReadOnlyList<JsonElement>, CancellationToken, Task> _sendBatchAsync;
    private readonly Func<string, AgentEvent, CancellationToken, Task> _sendSingleAsync;
    private readonly Func<AgentEvent, JsonElement> _serializeEvent;

    private readonly object _sync = new();
    private readonly List<BufferedEvent> _buffer = [];
    private readonly Timer _flushTimer;

    private bool _isFlushing;
    private bool _flushRequested;
    private bool _disposing;
    private bool _disposed;
    private int _accumulatedTextLength;

    private sealed class BufferedEvent
    {
        public required string RunId { get; init; }
        public required AgentEvent Event { get; init; }
        public required JsonElement Serialized { get; init; }
        public required int TextLength { get; init; }
    }

    public AgentEventBatcher(
        Func<string, IReadOnlyList<JsonElement>, CancellationToken, Task> sendBatchAsync,
        Func<string, AgentEvent, CancellationToken, Task> sendSingleAsync,
        Func<AgentEvent, JsonElement> serializeEvent)
    {
        _sendBatchAsync = sendBatchAsync;
        _sendSingleAsync = sendSingleAsync;
        _serializeEvent = serializeEvent;

        _flushTimer = new Timer(FlushTimerCallback, this, FlushInterval, FlushInterval);
    }

    public async Task EnqueueAsync(string runId, AgentEvent evt, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();

        if (IsBoundaryEvent(evt))
        {
            await FlushAsync(ct).ConfigureAwait(false);
            await _sendSingleAsync(runId, evt, ct).ConfigureAwait(false);
            return;
        }

        bool shouldFlush;

        lock (_sync)
        {
            ThrowIfNotUsable();
            AddToBufferLocked(runId, evt);
            shouldFlush = _accumulatedTextLength >= SizeThresholdChars;
        }

        if (shouldFlush)
            await FlushAsync(ct).ConfigureAwait(false);
    }

    public async Task FlushAsync(CancellationToken ct)
    {
        while (true)
        {
            List<BufferedEvent> batch;
            string runId;

            lock (_sync)
            {
                if (_disposed)
                    return;

                if (_isFlushing)
                {
                    _flushRequested = true;
                    return;
                }

                if (_buffer.Count == 0)
                    return;

                batch = new List<BufferedEvent>(_buffer);
                runId = batch[0].RunId;
                _buffer.Clear();
                _accumulatedTextLength = 0;
                _isFlushing = true;
            }

            bool shouldRepeat;
            try
            {
                var events = batch.Select(item => item.Serialized).ToList();
                await _sendBatchAsync(runId, events, ct).ConfigureAwait(false);
            }
            finally
            {
                lock (_sync)
                {
                    shouldRepeat = _flushRequested && _buffer.Count > 0;
                    _flushRequested = false;
                    _isFlushing = false;
                }
            }

            if (!shouldRepeat)
                return;
        }
    }

    public async ValueTask DisposeAsync()
    {
        lock (_sync)
        {
            if (_disposing)
                return;

            _disposing = true;
        }

        _flushTimer.Change(Timeout.Infinite, Timeout.Infinite);
        _flushTimer.Dispose();

        await FlushAsync(CancellationToken.None).ConfigureAwait(false);

        lock (_sync)
        {
            _disposed = true;
        }
    }

    private void FlushTimerCallback(object? state)
    {
        _ = FlushAsync(CancellationToken.None);
    }

    private void AddToBufferLocked(string runId, AgentEvent evt)
    {
        if (TryMergeWithLastLocked(evt))
            return;

        _buffer.Add(new BufferedEvent
        {
            RunId = runId,
            Event = evt,
            Serialized = _serializeEvent(evt),
            TextLength = GetTextLength(evt)
        });

        _accumulatedTextLength += GetTextLength(evt);
    }

    private bool TryMergeWithLastLocked(AgentEvent evt)
    {
        if (_buffer.Count == 0)
            return false;

        var last = _buffer[^1];

        if (last.Event is TextDeltaEvent lastText && evt is TextDeltaEvent textDelta)
        {
            var merged = new TextDeltaEvent
            {
                Text = lastText.Text + textDelta.Text
            };
            var mergedTextLength = last.TextLength + textDelta.Text.Length;

            _buffer[^1] = new BufferedEvent
            {
                RunId = last.RunId,
                Event = merged,
                Serialized = _serializeEvent(merged),
                TextLength = mergedTextLength
            };

            _accumulatedTextLength += textDelta.Text.Length;
            return true;
        }

        if (last.Event is ThinkingDeltaEvent lastThinking && evt is ThinkingDeltaEvent thinkingDelta)
        {
            var merged = new ThinkingDeltaEvent
            {
                Thinking = lastThinking.Thinking + thinkingDelta.Thinking
            };
            var mergedTextLength = last.TextLength + thinkingDelta.Thinking.Length;

            _buffer[^1] = new BufferedEvent
            {
                RunId = last.RunId,
                Event = merged,
                Serialized = _serializeEvent(merged),
                TextLength = mergedTextLength
            };

            _accumulatedTextLength += thinkingDelta.Thinking.Length;
            return true;
        }

        return false;
    }

    private static int GetTextLength(AgentEvent evt)
    {
        return evt switch
        {
            TextDeltaEvent text => text.Text.Length,
            ThinkingDeltaEvent thinking => thinking.Thinking.Length,
            _ => 0
        };
    }

    private static bool IsBoundaryEvent(AgentEvent evt)
    {
        return evt.Type is not "text_delta" and not "thinking_delta" and not "tool_use_args_delta";
    }

    private void ThrowIfNotUsable()
    {
        if (_disposing)
            throw new ObjectDisposedException(nameof(AgentEventBatcher));

        if (_disposed)
            throw new ObjectDisposedException(nameof(AgentEventBatcher));
    }
}
