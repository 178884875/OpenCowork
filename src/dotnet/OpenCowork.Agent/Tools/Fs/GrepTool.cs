using System.IO.Pipelines;
using System.Text;
using System.Text.RegularExpressions;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// High-performance grep using System.IO.Pipelines and compiled Regex.
/// Reads files through PipeReader for minimal allocation.
/// </summary>
public static class GrepTool
{
    public const int DefaultMaxResults = 500;
    public const int DefaultContextLines = 0;
    public const long MaxFileSizeBytes = 5 * 1024 * 1024; // 5MB

    public static async Task<GrepResult> SearchAsync(
        string directory,
        string pattern,
        GrepOptions? options = null,
        CancellationToken ct = default)
    {
        var opts = options ?? new GrepOptions();
        var regex = new Regex(pattern,
            RegexOptions.Compiled | RegexOptions.NonBacktracking |
            (opts.CaseInsensitive ? RegexOptions.IgnoreCase : RegexOptions.None));

        var result = new GrepResult();
        var files = EnumerateFiles(directory, opts);

        await Parallel.ForEachAsync(files, new ParallelOptions
        {
            MaxDegreeOfParallelism = Environment.ProcessorCount,
            CancellationToken = ct
        }, async (filePath, token) =>
        {
            if (result.Matches.Count >= (opts.MaxResults ?? DefaultMaxResults))
                return;

            try
            {
                var fileInfo = new FileInfo(filePath);
                if (fileInfo.Length > MaxFileSizeBytes) return;
                if (IsBinaryFile(filePath)) return;

                var matches = await SearchFileAsync(filePath, regex, directory, opts, token);
                if (matches.Count > 0)
                {
                    lock (result.Matches)
                    {
                        result.Matches.AddRange(matches);
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Skip inaccessible files
            }
        });

        result.TotalMatches = result.Matches.Count;
        if (result.Matches.Count > (opts.MaxResults ?? DefaultMaxResults))
        {
            result.Matches = result.Matches.Take(opts.MaxResults ?? DefaultMaxResults).ToList();
            result.Truncated = true;
        }

        return result;
    }

    private static async Task<List<GrepMatch>> SearchFileAsync(
        string filePath, Regex regex, string baseDir,
        GrepOptions opts, CancellationToken ct)
    {
        var matches = new List<GrepMatch>();
        var relativePath = Path.GetRelativePath(baseDir, filePath);

        await using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 4096, FileOptions.SequentialScan | FileOptions.Asynchronous);

        var lineNumber = 0;
        using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);

        while (await reader.ReadLineAsync(ct) is { } line)
        {
            lineNumber++;
            if (regex.IsMatch(line))
            {
                matches.Add(new GrepMatch
                {
                    File = relativePath,
                    Line = lineNumber,
                    Content = line.Length > 500 ? line[..500] + "..." : line
                });

                if (matches.Count >= (opts.MaxResults ?? DefaultMaxResults))
                    break;
            }
        }

        return matches;
    }

    private static IEnumerable<string> EnumerateFiles(string directory, GrepOptions opts)
    {
        var enumOptions = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            MatchCasing = MatchCasing.PlatformDefault
        };

        IEnumerable<string> files;
        if (!string.IsNullOrEmpty(opts.GlobPattern))
        {
            var matcher = new Microsoft.Extensions.FileSystemGlobbing.Matcher();
            matcher.AddInclude(opts.GlobPattern);
            var matchResult = matcher.Execute(
                new Microsoft.Extensions.FileSystemGlobbing.Abstractions.DirectoryInfoWrapper(
                    new DirectoryInfo(directory)));
            files = matchResult.Files.Select(f => Path.Combine(directory, f.Path));
        }
        else
        {
            files = Directory.EnumerateFiles(directory, "*", enumOptions);
        }

        return files.Where(f => !ShouldIgnore(f, directory));
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
}

public class GrepOptions
{
    public bool CaseInsensitive { get; init; }
    public int? MaxResults { get; init; }
    public string? GlobPattern { get; init; }
}

public class GrepResult
{
    public List<GrepMatch> Matches { get; set; } = [];
    public int TotalMatches { get; set; }
    public bool Truncated { get; set; }
}

public class GrepMatch
{
    public required string File { get; init; }
    public int Line { get; init; }
    public required string Content { get; init; }
}
