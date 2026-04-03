namespace OpenCowork.Agent.Engine;

public sealed class CompressionConfig
{
    public bool Enabled { get; init; }
    public int ContextLength { get; init; }
    public double Threshold { get; init; } = 0.8;
    public double PreCompressThreshold { get; init; } = 0.65;
}

/// <summary>
/// Context compression logic for managing conversation length.
/// Two-tier: pre-compression (trim tool results/thinking) and
/// full compression (summarize via LLM).
/// </summary>
public static class ContextCompression
{
    public static bool ShouldCompress(int inputTokens, CompressionConfig config)
    {
        if (!config.Enabled || config.ContextLength <= 0) return false;
        return (double)inputTokens / config.ContextLength >= config.Threshold;
    }

    public static bool ShouldPreCompress(int inputTokens, CompressionConfig config)
    {
        if (!config.Enabled || config.ContextLength <= 0) return false;
        var ratio = (double)inputTokens / config.ContextLength;
        return ratio >= config.PreCompressThreshold && ratio < config.Threshold;
    }

    /// <summary>
    /// Pre-compress by replacing long tool results and thinking blocks in older messages.
    /// Preserves the last 6 messages. Does not call the LLM.
    /// </summary>
    public static List<UnifiedMessage> PreCompressMessages(List<UnifiedMessage> messages)
    {
        if (messages.Count <= 6) return messages;

        var result = new List<UnifiedMessage>(messages.Count);
        var preserveFrom = messages.Count - 6;

        for (var i = 0; i < messages.Count; i++)
        {
            if (i >= preserveFrom)
            {
                result.Add(messages[i]);
                continue;
            }

            var msg = messages[i];
            var blocks = msg.Content;
            if (blocks is null || blocks.Count == 0)
            {
                result.Add(msg);
                continue;
            }

            var compressed = false;
            var newContent = new List<ContentBlock>();

            foreach (var block in blocks)
            {
                if (block is ToolResultBlock trb && trb.GetTextContent().Length > 200)
                {
                    newContent.Add(new ToolResultBlock
                    {
                        ToolUseId = trb.ToolUseId,
                        Content = "[Tool result compressed]",
                        IsError = trb.IsError
                    });
                    compressed = true;
                }
                else if (block is ThinkingBlock)
                {
                    newContent.Add(new TextBlock { Text = "[Thinking compressed]" });
                    compressed = true;
                }
                else
                {
                    newContent.Add(block);
                }
            }

            if (compressed)
            {
                result.Add(new UnifiedMessage
                {
                    Id = msg.Id,
                    Role = msg.Role,
                    Content = newContent
                });
            }
            else
            {
                result.Add(msg);
            }
        }

        return result;
    }

    /// <summary>
    /// Full compression: summarize the conversation history via the LLM provider.
    /// Returns a compressed message list with a summary replacing middle history.
    /// </summary>
    public static async Task<List<UnifiedMessage>> CompressMessagesAsync(
        List<UnifiedMessage> messages,
        Providers.ILlmProvider provider,
        ProviderConfig config,
        CancellationToken ct)
    {
        if (messages.Count <= 2) return messages;

        // Keep first (system) and last messages, summarize the middle
        var systemMsg = messages.FirstOrDefault(m => m.Role == "system");
        var lastMessages = messages.TakeLast(2).ToList();

        var middleMessages = messages
            .Skip(systemMsg is not null ? 1 : 0)
            .Take(messages.Count - (systemMsg is not null ? 3 : 2))
            .ToList();

        if (middleMessages.Count == 0) return messages;

        // Build summary request
        var summaryText = new System.Text.StringBuilder();
        foreach (var msg in middleMessages)
        {
            summaryText.Append($"[{msg.Role}]: ");
            summaryText.AppendLine(msg.GetTextContent());
        }

        var summaryRequest = new List<UnifiedMessage>
        {
            new()
            {
                Role = "user",
                Content = new List<ContentBlock>
                {
                    new TextBlock
                    {
                        Text = $"""
                        Summarize the following conversation concisely, preserving all key facts,
                        decisions, tool call results, and context needed to continue the conversation.
                        Keep it under 2000 characters.

                        ---
                        {summaryText}
                        """
                    }
                }
            }
        };

        var summaryConfig = new ProviderConfig
        {
            Type = config.Type,
            ApiKey = config.ApiKey,
            BaseUrl = config.BaseUrl,
            Model = config.Model,
            MaxTokens = 2000,
            SystemPrompt = "You are a conversation summarizer. Output only the summary."
        };

        var summaryBuilder = new System.Text.StringBuilder();
        await foreach (var evt in provider.SendMessageAsync(
            summaryRequest, [], summaryConfig, ct))
        {
            if (evt.Type == "text_delta" && evt.Text is not null)
                summaryBuilder.Append(evt.Text);
        }

        var result = new List<UnifiedMessage>();
        if (systemMsg is not null) result.Add(systemMsg);

        result.Add(new UnifiedMessage
        {
            Role = "user",
            Content = new List<ContentBlock>
            {
                new TextBlock
                {
                    Text = $"[Previous conversation summary]\n{summaryBuilder}"
                }
            }
        });

        result.AddRange(lastMessages);
        return result;
    }
}
