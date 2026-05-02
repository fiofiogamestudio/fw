using System.Collections.ObjectModel;

namespace Fw.Rt.Systems;

public interface ISystem<TContext>
    where TContext : class
{
    void Init(TContext context);
    void Tick(float dt);
    void Shutdown();
}

public sealed class SystemRuntime
{
    private readonly List<Entry> _entries = [];
    private readonly Dictionary<string, Entry> _entriesById = new(StringComparer.Ordinal);
    private readonly List<string> _phaseOrder = [];

    public IReadOnlyList<string> PhaseOrder => new ReadOnlyCollection<string>(_phaseOrder);

    public void SetPhaseOrder(IEnumerable<string> order)
    {
        _phaseOrder.Clear();
        foreach (var rawPhase in order)
        {
            var phase = rawPhase.Trim();
            if (phase.Length == 0 || _phaseOrder.Contains(phase, StringComparer.Ordinal))
            {
                continue;
            }
            _phaseOrder.Add(phase);
        }
    }

    public void Add<TContext>(string id, ISystem<TContext> system, TContext context, string phase = "")
        where TContext : class
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new ArgumentException("System id cannot be empty.", nameof(id));
        }
        if (_entriesById.ContainsKey(id))
        {
            throw new InvalidOperationException($"Duplicate system id: {id}");
        }

        ArgumentNullException.ThrowIfNull(system);
        ArgumentNullException.ThrowIfNull(context);

        var entry = new Entry(
            id,
            phase,
            context,
            () => system.Init(context),
            system.Tick,
            system.Shutdown
        );
        _entries.Add(entry);
        _entriesById[id] = entry;
    }

    public bool Has(string id)
    {
        return _entriesById.ContainsKey(id);
    }

    public TContext? GetContext<TContext>(string id)
        where TContext : class
    {
        return _entriesById.TryGetValue(id, out var entry)
            ? entry.Context as TContext
            : null;
    }

    public void InitAll()
    {
        foreach (var entry in OrderedEntries())
        {
            entry.Init();
        }
    }

    public void Tick(float dt)
    {
        foreach (var entry in OrderedEntries())
        {
            entry.Tick(dt);
        }
    }

    public void TickPhase(string phase, float dt)
    {
        foreach (var entry in OrderedEntries())
        {
            if (entry.Phase != phase)
            {
                continue;
            }
            entry.Tick(dt);
        }
    }

    public void ShutdownAll()
    {
        var ordered = OrderedEntries();
        for (var i = ordered.Count - 1; i >= 0; i--)
        {
            ordered[i].Shutdown();
        }
        _entries.Clear();
        _entriesById.Clear();
        _phaseOrder.Clear();
    }

    private List<Entry> OrderedEntries()
    {
        if (_phaseOrder.Count == 0)
        {
            return [.. _entries];
        }

        var ordered = new List<Entry>();
        var added = new HashSet<string>(StringComparer.Ordinal);
        foreach (var phase in _phaseOrder)
        {
            foreach (var entry in _entries)
            {
                if (entry.Phase != phase)
                {
                    continue;
                }
                ordered.Add(entry);
                added.Add(entry.Id);
            }
        }

        foreach (var entry in _entries)
        {
            if (added.Contains(entry.Id))
            {
                continue;
            }
            ordered.Add(entry);
        }
        return ordered;
    }

    private sealed record Entry(
        string Id,
        string Phase,
        object Context,
        Action Init,
        Action<float> Tick,
        Action Shutdown
    );
}
