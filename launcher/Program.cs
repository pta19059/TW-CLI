using System.Diagnostics;
using System.Text;
using System.Threading;

static string ResolveProjectRoot()
{
    var cwd = Directory.GetCurrentDirectory();
    var cwdScript = Path.Combine(cwd, "dist", "index.js");
    if (File.Exists(cwdScript))
    {
        return cwd;
    }

    var processPath = Environment.ProcessPath;
    var exeDir = string.IsNullOrWhiteSpace(processPath)
        ? AppContext.BaseDirectory
        : Path.GetDirectoryName(processPath) ?? AppContext.BaseDirectory;

    var direct = Path.Combine(exeDir, "dist", "index.js");
    if (File.Exists(direct))
    {
        return exeDir;
    }

    var parent = Directory.GetParent(exeDir)?.FullName;
    if (!string.IsNullOrWhiteSpace(parent))
    {
        var parentScript = Path.Combine(parent, "dist", "index.js");
        if (File.Exists(parentScript))
        {
            return parent;
        }
    }

    var envHome = Environment.GetEnvironmentVariable("TWC_HOME");
    if (!string.IsNullOrWhiteSpace(envHome))
    {
        var envScript = Path.Combine(envHome, "dist", "index.js");
        if (File.Exists(envScript))
        {
            return envHome;
        }
    }

    throw new InvalidOperationException("Cannot locate dist/index.js. Run twc.exe from the project root or set TWC_HOME to project path.");
}

static int RunNode(string root, IReadOnlyList<string> args)
{
    var scriptPath = Path.Combine(root, "dist", "index.js");

    var psi = new ProcessStartInfo
    {
        FileName = "node",
        WorkingDirectory = root,
        UseShellExecute = false,
    };

    psi.ArgumentList.Add(scriptPath);
    foreach (var arg in args)
    {
        psi.ArgumentList.Add(arg);
    }

    using var process = Process.Start(psi);
    if (process is null)
    {
        Console.Error.WriteLine("Failed to start node process.");
        return 1;
    }

    process.WaitForExit();
    return process.ExitCode;
}

static void RunClickMode(string root)
{
    DrawAnimatedIntro();
    Console.WriteLine("Icon mode active. Type a command and press Enter (the 'twc' prefix is optional).");
    Console.WriteLine("Commands:    products list | jobs list | jobs show <jobId> | doctor");
    Console.WriteLine("Troubleshoot: troubleshoot teamviewer-remote --target ep-001 --issue \"Session drop\"");
    Console.WriteLine("Natural language: tensor cannot reach device vm-twc-demo");
    Console.WriteLine("Type 'help' for assistance, 'exit' to close.");
    Console.WriteLine();

    while (true)
    {
        Console.Write("twc> ");
        var line = Console.ReadLine();

        if (line is null)
        {
            break;
        }

        var trimmed = line.Trim();
        if (trimmed.Length == 0)
        {
            continue;
        }

        if (trimmed.Equals("exit", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Equals("quit", StringComparison.OrdinalIgnoreCase))
        {
            break;
        }

        var args = trimmed.Equals("help", StringComparison.OrdinalIgnoreCase)
            ? new List<string> { "--help" }
            : SplitArgs(trimmed);

        // Be forgiving: the banner and examples all show a `twc` prefix, so
        // users naturally type `twc jobs show X` at the `twc>` prompt. Strip a
        // single leading `twc` token so it behaves exactly like `jobs show X`
        // instead of being treated as free-text and triggering a troubleshoot.
        if (args.Count > 0 && args[0].Equals("twc", StringComparison.OrdinalIgnoreCase))
        {
            args.RemoveAt(0);
        }

        if (args.Count == 0)
        {
            continue;
        }

        RunNode(root, args);
        Console.WriteLine();
    }
}

static void DrawAnimatedIntro()
{
    const string reset = "\u001b[0m";
    const string cyan = "\u001b[36m";
    const string blue = "\u001b[34m";
    const string green = "\u001b[32m";
    var useAnsi = !Console.IsOutputRedirected;
    var cReset = useAnsi ? reset : string.Empty;
    var cCyan = useAnsi ? cyan : string.Empty;
    var cBlue = useAnsi ? blue : string.Empty;
    var cGreen = useAnsi ? green : string.Empty;

    Console.Clear();
    Console.WriteLine("$ twc");
    Console.WriteLine();

    var title = "TeamViewer CLI v0.1.0";
    var subtitle = "Describe a task to get started.";
    var tip = "Tip: help shows available commands. exit closes the session.";
    var wordmark = new[]
    {
        "TTTTTT  EEEEEE   AAAAA   M   M  V   V  III  EEEEEE  W     W  III  EEEEEE  RRRR  ",
        "  TT    EE      AA   AA  MM MM  V   V   I   EE      W  W  W   I   EE      RR  RR ",
        "  TT    EEEE    AAAAAAA  M M M  V   V   I   EEEE    W  W  W   I   EEEE    RRRR   ",
        "  TT    EE      AA   AA  M   M   V V    I   EE      W W W W   I   EE      RR RR  ",
        "  TT    EEEEEE  AA   AA  M   M    V    III  EEEEEE   WW WW   III  EEEEEE  RR  RR "
    };

    Console.WriteLine($"{cBlue}+------------------------------------------------------------------+{cReset}");
    Console.WriteLine($"{cBlue}|{cReset} {cCyan}{title.PadRight(64)}{cReset} {cBlue}|{cReset}");
    Console.WriteLine($"{cBlue}|{cReset} {subtitle.PadRight(64)} {cBlue}|{cReset}");
    Console.WriteLine($"{cBlue}+------------------------------------------------------------------+{cReset}");
    Console.WriteLine();

    foreach (var line in wordmark)
    {
        Console.WriteLine($"{cCyan}{line}{cReset}");
        Thread.Sleep(18);
    }

    Console.WriteLine();
    Console.WriteLine($"{cGreen}{tip}{cReset}");
    Console.WriteLine();

    var frames = new[] { "[=     ]", "[==    ]", "[===   ]", "[ ==== ]", "[  ====]", "[   ===]", "[    ==]", "[     =]", "[ READY ]" };
    Console.Write("Loading TeamViewer shell ");

    foreach (var frame in frames)
    {
        Console.Write($"\rLoading TeamViewer shell {cCyan}{frame}{cReset}");
        Thread.Sleep(80);
    }

    Console.WriteLine();
    Console.WriteLine();
}

static List<string> SplitArgs(string commandLine)
{
    var args = new List<string>();
    var current = new StringBuilder();
    var inQuotes = false;

    foreach (var ch in commandLine)
    {
        if (ch == '"')
        {
            inQuotes = !inQuotes;
            continue;
        }

        if (char.IsWhiteSpace(ch) && !inQuotes)
        {
            if (current.Length > 0)
            {
                args.Add(current.ToString());
                current.Clear();
            }
            continue;
        }

        current.Append(ch);
    }

    if (current.Length > 0)
    {
        args.Add(current.ToString());
    }

    return args;
}

try
{
    var root = ResolveProjectRoot();
    var incomingArgs = Environment.GetCommandLineArgs().Skip(1).ToArray();

    if (incomingArgs.Length == 0)
    {
        RunClickMode(root);
        Environment.Exit(0);
        return;
    }

    var exitCode = RunNode(root, incomingArgs);
    Environment.Exit(exitCode);
}
catch (Exception ex)
{
    Console.Error.WriteLine($"twc launcher error: {ex.Message}");
    Environment.Exit(1);
}
