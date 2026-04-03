using System.Text;
using Microsoft.Extensions.FileSystemGlobbing;

namespace OpenCowork.Agent.Tools.Fs;

/// <summary>
/// Core filesystem operations: read, write, list, mkdir, delete, move.
/// </summary>
public static class FsOperations
{
    public static async Task<string> ReadFileAsync(string path, int? offset = null,
        int? limit = null, CancellationToken ct = default)
    {
        if (!File.Exists(path))
            throw new FileNotFoundException($"File not found: {path}");

        if (offset is null && limit is null)
            return await File.ReadAllTextAsync(path, ct);

        var lines = await File.ReadAllLinesAsync(path, ct);
        var start = Math.Max(0, (offset ?? 1) - 1);
        var count = limit ?? (lines.Length - start);
        count = Math.Min(count, lines.Length - start);

        if (start >= lines.Length)
            return "";

        var sb = new StringBuilder();
        for (var i = start; i < start + count && i < lines.Length; i++)
        {
            var lineNum = (i + 1).ToString().PadLeft(6);
            sb.Append(lineNum).Append('|').AppendLine(lines[i]);
        }
        return sb.ToString();
    }

    public static async Task WriteFileAsync(string path, string content,
        CancellationToken ct = default)
    {
        var dir = Path.GetDirectoryName(path);
        if (dir is not null && !Directory.Exists(dir))
            Directory.CreateDirectory(dir);

        await File.WriteAllTextAsync(path, content, ct);
    }

    public static List<FsEntry> ListDirectory(string path, bool showHidden = false, IEnumerable<string>? ignore = null)
    {
        var dir = new DirectoryInfo(path);
        if (!dir.Exists)
            throw new DirectoryNotFoundException($"Directory not found: {path}");

        var entries = new List<FsEntry>();
        var ignoreMatcher = BuildIgnoreMatcher(ignore);

        foreach (var d in dir.EnumerateDirectories())
        {
            if (!showHidden && d.Name.StartsWith('.')) continue;
            if (ShouldIgnoreDir(d.Name)) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, d.Name, isDirectory: true)) continue;

            entries.Add(new FsEntry
            {
                Name = d.Name,
                Type = "directory",
                Size = null,
                ModifiedAt = new DateTimeOffset(d.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        foreach (var f in dir.EnumerateFiles())
        {
            if (!showHidden && f.Name.StartsWith('.')) continue;
            if (ShouldIgnoreEntry(ignoreMatcher, f.Name, isDirectory: false)) continue;

            entries.Add(new FsEntry
            {
                Name = f.Name,
                Type = "file",
                Size = f.Length,
                ModifiedAt = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()
            });
        }

        return entries;
    }

    public static void CreateDirectory(string path)
    {
        Directory.CreateDirectory(path);
    }

    public static void Delete(string path)
    {
        if (File.Exists(path))
            File.Delete(path);
        else if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
        else
            throw new FileNotFoundException($"Path not found: {path}");
    }

    public static void Move(string source, string destination)
    {
        if (File.Exists(source))
            File.Move(source, destination, overwrite: true);
        else if (Directory.Exists(source))
            Directory.Move(source, destination);
        else
            throw new FileNotFoundException($"Source not found: {source}");
    }

    private static Matcher? BuildIgnoreMatcher(IEnumerable<string>? ignore)
    {
        if (ignore is null)
            return null;

        var matcher = new Matcher(StringComparison.OrdinalIgnoreCase);
        var hasPatterns = false;
        foreach (var pattern in ignore)
        {
            if (string.IsNullOrWhiteSpace(pattern))
                continue;

            hasPatterns = true;
            matcher.AddInclude(pattern.Replace('\\', '/'));
            matcher.AddInclude($"**/{pattern.Replace('\\', '/')}");
        }

        return hasPatterns ? matcher : null;
    }

    private static bool ShouldIgnoreEntry(Matcher? matcher, string name, bool isDirectory)
    {
        if (matcher is null)
            return false;

        var normalized = name.Replace('\\', '/');
        var candidates = isDirectory
            ? new[] { normalized, $"{normalized}/" }
            : new[] { normalized };

        return candidates.Any(candidate => matcher.Match(candidate).HasMatches);
    }

    private static bool ShouldIgnoreDir(string name) =>
        name is "node_modules" or ".git" or "__pycache__" or ".venv";
}

public class FsEntry
{
    public required string Name { get; init; }
    public required string Type { get; init; }
    public long? Size { get; init; }
    public long ModifiedAt { get; init; }
}
