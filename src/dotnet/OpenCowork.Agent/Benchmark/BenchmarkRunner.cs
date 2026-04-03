using System.Diagnostics;
using System.Text;
using System.Text.Json;
using OpenCowork.Agent.Providers;

namespace OpenCowork.Agent.Benchmark;

public static class BenchmarkRunner
{
    public static async Task<int> RunAsync(TextWriter output, CancellationToken ct = default)
    {
        var sample = "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello world\"}}";
        var utf8 = Encoding.UTF8.GetBytes(sample);
        const int iterations = 200_000;

        var sw = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
        {
            _ = JsonSerializer.Deserialize(utf8, AppJsonContext.Default.AnthropicSsePayload);
        }
        sw.Stop();

        await output.WriteLineAsync($"benchmark=json_deserialize iterations={iterations} elapsed_ms={sw.ElapsedMilliseconds}");
        await output.WriteLineAsync($"benchmark=throughput_per_sec value={(iterations / Math.Max(sw.Elapsed.TotalSeconds, 0.001)):F0}");
        return 0;
    }
}
