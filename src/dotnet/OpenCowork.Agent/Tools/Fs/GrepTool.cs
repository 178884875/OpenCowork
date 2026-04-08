using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.FileSystemGlobbing;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// High-performance grep using System.IO.Pipelines and compiled Regex.
/// Reads files through PipeReader for minimal allocation.
/// </summary>
public static class GrepTool
{
    public const int DefaultMaxResults = 500;
    public const int DefaultContextLines = 0;
    public const long DefaultMaxFileSizeBytes = 10 * 1024 * 1024;
    public const int DefaultMaxLineLength = 500;

    public static async Task<GrepResult> SearchAsync(
        string searchTarget,
        string pattern,
        GrepOptions? options = null,
        CancellationToken ct = default)
    {
        var opts = options ?? new GrepOptions();
        var regex = CreateRegex(pattern, opts.CaseInsensitive);
        var searchPath = Path.GetFullPath(searchTarget);
        var searchRoot = Directory.Exists(searchPath)
            ? searchPath
            : Path.GetDirectoryName(searchPath) ?? Environment.CurrentDirectory;
        var collector = new GrepCollector(
            opts.MaxResults ?? DefaultMaxResults,
            opts.MaxOutputBytes,
            opts.MaxLineLength ?? DefaultMaxLineLength);

        using var timeoutCts = opts.TimeoutMs is > 0
            ? new CancellationTokenSource(TimeSpan.FromMilliseconds(opts.TimeoutMs.Value))
            : null;
        using var linkedCts = timeoutCts is null
            ? CancellationTokenSource.CreateLinkedTokenSource(ct)
            : CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

        var files = EnumerateFiles(searchPath, searchRoot, opts);

        try
        {
            await Parallel.ForEachAsync(files, new ParallelOptions
            {
                MaxDegreeOfParallelism = opts.MaxDegreeOfParallelism ?? Environment.ProcessorCount,
                CancellationToken = linkedCts.Token
            }, async (filePath, token) =>
            {
                if (collector.IsLimited) return;

                try
                {
                    var fileInfo = new FileInfo(filePath);
                    if (fileInfo.Length == 0) return;
                    if (fileInfo.Length > (opts.MaxFileSizeBytes ?? DefaultMaxFileSizeBytes)) return;
                    if (IsBinaryFile(filePath)) return;

                    await SearchFileAsync(filePath, regex, searchRoot, collector, token);
                    if (collector.IsLimited && !linkedCts.IsCancellationRequested)
                    {
                        linkedCts.Cancel();
                    }
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                }
            });
        }
        catch (OperationCanceledException) when (
            collector.IsLimited ||
            timeoutCts?.IsCancellationRequested == true)
        {
        }

        if (ct.IsCancellationRequested &&
            timeoutCts?.IsCancellationRequested != true &&
            !collector.IsLimited)
        {
            ct.ThrowIfCancellationRequested();
        }

        var matches = collector.Snapshot();
        var timedOut = timeoutCts?.IsCancellationRequested == true;

        return new GrepResult
        {
            Matches = matches,
            TotalMatches = matches.Count,
            Truncated = collector.IsLimited || timedOut,
            LimitReason = timedOut ? "timeout" : collector.LimitReason
        };
    }

    private static Regex CreateRegex(string pattern, bool caseInsensitive)
    {
        var options = RegexOptions.Compiled | (caseInsensitive ? RegexOptions.IgnoreCase : RegexOptions.None);
        try
        {
            return new Regex(pattern, options | RegexOptions.NonBacktracking);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException)
        {
            return new Regex(pattern, options);
        }
    }

    private static async Task SearchFileAsync(
        string filePath,
        Regex regex,
        string baseDir,
        GrepCollector collector,
        CancellationToken ct)
    {
        var relativePath = Path.GetRelativePath(baseDir, filePath);

        await using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 4096, FileOptions.SequentialScan | FileOptions.Asynchronous);

        var lineNumber = 0;
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

        while (await reader.ReadLineAsync(ct) is { } line)
        {
            lineNumber++;
            if (!regex.IsMatch(line)) continue;
            if (!collector.TryAppend(relativePath, lineNumber, line)) return;
        }
    }

    private static IEnumerable<string> EnumerateFiles(string searchTarget, string baseDir, GrepOptions opts)
    {
        var matcher = CreateIncludeMatcher(opts);

        if (File.Exists(searchTarget))
        {
            return ShouldSearchFile(searchTarget, baseDir, matcher) ? [searchTarget] : [];
        }

        var enumOptions = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            MatchCasing = MatchCasing.PlatformDefault
        };

        return Directory.EnumerateFiles(searchTarget, "*", enumOptions)
            .Where(filePath => ShouldSearchFile(filePath, baseDir, matcher));
    }

    private static bool ShouldSearchFile(string filePath, string baseDir, Matcher? matcher)
    {
        if (ShouldIgnore(filePath, baseDir)) return false;
        if (matcher is null) return true;

        var relativePath = Path.GetRelativePath(baseDir, filePath)
            .Replace(Path.DirectorySeparatorChar, '/')
            .Replace(Path.AltDirectorySeparatorChar, '/');
        return matcher.Match(relativePath).HasMatches;
    }

    private static Matcher? CreateIncludeMatcher(GrepOptions opts)
    {
        var patterns = ResolveGlobPatterns(opts);
        if (patterns.Count == 0) return null;

        var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
        foreach (var pattern in patterns)
        {
            matcher.AddInclude(NormalizeGlobPattern(pattern));
        }

        return matcher;
    }

    private static IReadOnlyList<string> ResolveGlobPatterns(GrepOptions opts)
    {
        if (opts.GlobPatterns is { Count: > 0 })
        {
            return opts.GlobPatterns
                .Where(static pattern => !string.IsNullOrWhiteSpace(pattern))
                .Select(static pattern => pattern.Trim())
                .ToArray();
        }

        if (string.IsNullOrWhiteSpace(opts.GlobPattern)) return [];

        return opts.GlobPattern
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(static pattern => !string.IsNullOrWhiteSpace(pattern))
            .ToArray();
    }

    private static string NormalizeGlobPattern(string pattern)
    {
        var normalized = pattern.Replace('\\', '/').Trim();
        if (normalized.StartsWith("./", StringComparison.Ordinal))
        {
            normalized = normalized[2..];
        }

        if (normalized.StartsWith("**/", StringComparison.Ordinal))
        {
            normalized = normalized[3..];
        }

        if (!normalized.Contains('/') && normalized.StartsWith("*.", StringComparison.Ordinal))
        {
            return $"**/{normalized}";
        }

        if (!normalized.Contains('*') && !normalized.Contains('?') && normalized.StartsWith(".", StringComparison.Ordinal))
        {
            return $"*{normalized}";
        }

        return normalized;
    }

    private static bool ShouldIgnore(string filePath, string baseDir)
    {
        var relative = Path.GetRelativePath(baseDir, filePath);
        var parts = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

        foreach (var part in parts)
        {
            if (part is "node_modules" or ".git" or "dist" or "out" or "bin" or "obj" or
                ".next" or ".nuxt" or "__pycache__" or ".venv" or "coverage")
                return true;
        }

        var ext = Path.GetExtension(filePath).ToLowerInvariant();
        return ext is ".exe" or ".dll" or ".so" or ".dylib" or ".png" or ".jpg" or
            ".jpeg" or ".gif" or ".bmp" or ".ico" or ".woff" or ".woff2" or ".ttf" or
            ".eot" or ".zip" or ".tar" or ".gz" or ".7z" or ".pdf" or ".mp4" or
            ".mp3" or ".wav" or ".avi" or ".mov";
    }

    private static bool IsBinaryFile(string filePath)
    {
        try
        {
            using var stream = File.OpenRead(filePath);
            Span<byte> buffer = stackalloc byte[512];
            var bytesRead = stream.Read(buffer);
            if (bytesRead == 0) return false;

            var slice = buffer[..bytesRead];
            for (var i = 0; i < slice.Length; i++)
            {
                if (slice[i] == 0) return true;
            }
            return false;
        }
        catch
        {
            return true;
        }
    }

    private static string NormalizeLine(string text, int maxLineLength)
    {
        var normalized = text.Trim();
        if (normalized.Length <= maxLineLength) return normalized;
        return normalized[..(maxLineLength - 1)] + '…';
    }

    private sealed class GrepCollector
    {
        private readonly object _sync = new();
        private readonly int _maxResults;
        private readonly int? _maxOutputBytes;
        private readonly int _maxLineLength;
        private readonly List<GrepMatch> _matches = [];
        private int _totalBytes = 2;

        public GrepCollector(int maxResults, int? maxOutputBytes, int maxLineLength)
        {
            _maxResults = maxResults;
            _maxOutputBytes = maxOutputBytes;
            _maxLineLength = maxLineLength;
        }

        public string? LimitReason { get; private set; }

        public bool IsLimited => LimitReason is not null;

        public bool TryAppend(string file, int line, string content)
        {
            lock (_sync)
            {
                if (LimitReason is not null) return false;
                if (_matches.Count >= _maxResults)
                {
                    LimitReason = "max_results";
                    return false;
                }

                var normalized = NormalizeLine(content, _maxLineLength);
                var candidateBytes = Encoding.UTF8.GetByteCount(file) + Encoding.UTF8.GetByteCount(normalized) + 32;
                if (_maxOutputBytes is int maxOutputBytes && _totalBytes + candidateBytes > maxOutputBytes)
                {
                    LimitReason = "max_output_bytes";
                    return false;
                }

                _matches.Add(new GrepMatch
                {
                    File = file,
                    Line = line,
                    Content = normalized
                });
                _totalBytes += candidateBytes + 1;
                return true;
            }
        }

        public List<GrepMatch> Snapshot()
        {
            lock (_sync)
            {
                return _matches
                    .OrderBy(static match => match.File, StringComparer.OrdinalIgnoreCase)
                    .ThenBy(static match => match.Line)
                    .ToList();
            }
        }
    }
}

public class GrepOptions
{
    public bool CaseInsensitive { get; init; }
    public int? MaxResults { get; init; }
    public string? GlobPattern { get; init; }
    public IReadOnlyList<string>? GlobPatterns { get; init; }
    public long? MaxFileSizeBytes { get; init; }
    public int? MaxLineLength { get; init; }
    public int? MaxOutputBytes { get; init; }
    public int? TimeoutMs { get; init; }
    public int? MaxDegreeOfParallelism { get; init; }
}

public class GrepResult
{
    public List<GrepMatch> Matches { get; set; } = [];
    public int TotalMatches { get; set; }
    public bool Truncated { get; set; }
    public string? LimitReason { get; set; }
}

public class GrepMatch
{
    public required string File { get; init; }
    public int Line { get; init; }
    public required string Content { get; init; }
}
