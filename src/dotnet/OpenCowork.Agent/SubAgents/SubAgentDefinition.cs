using System.Text.Json.Serialization;

namespace OpenCowork.Agent.SubAgents;

/// <summary>
/// Static definition for a sub-agent. Mirrors the TypeScript SubAgentDefinition.
/// </summary>
public sealed class SubAgentDefinition
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("description")]
    public string? Description { get; init; }

    [JsonPropertyName("systemPrompt")]
    public string? SystemPrompt { get; init; }

    [JsonPropertyName("tools")]
    public List<string>? Tools { get; init; }

    [JsonPropertyName("disallowedTools")]
    public List<string>? DisallowedTools { get; init; }

    /// <summary>
    /// 0 (default) = unlimited — the sub-agent loop runs until the model stops
    /// calling tools. Any positive value caps the number of iterations.
    /// </summary>
    [JsonPropertyName("maxTurns")]
    public int MaxTurns { get; init; } = 0;

    [JsonPropertyName("initialPrompt")]
    public string? InitialPrompt { get; init; }

    [JsonPropertyName("model")]
    public string? Model { get; init; }

    [JsonPropertyName("temperature")]
    public double? Temperature { get; init; }
}
