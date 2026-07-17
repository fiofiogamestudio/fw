using System.Collections.ObjectModel;

namespace Fw.Rt.Systems;

public interface ISystem<TContext>
    where TContext : class
{
    void Init(TContext context);
    void Tick(float dt);
    void Shutdown();
}

public enum SystemRuntimeState
{
    Created,
    Initializing,
    Running,
    Faulted,
    Stopping,
    Stopped,
}

public sealed class SystemRuntime
{
    private readonly List<Entry> _entries = [];
    private readonly Dictionary<string, Entry> _entriesById = new(StringComparer.Ordinal);
    private readonly List<Entry> _initializedEntries = [];
    private readonly List<string> _phaseOrder = [];
    private List<Entry>? _orderedEntries;

    public IReadOnlyList<string> PhaseOrder => new ReadOnlyCollection<string>(_phaseOrder);
    public SystemRuntimeState State { get; private set; } = SystemRuntimeState.Created;
    public bool IsRunning => State == SystemRuntimeState.Running;

    public void SetPhaseOrder(IEnumerable<string> order)
    {
        EnsureConfigurable();
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
        _orderedEntries = null;
    }

    public void Add<TContext>(string id, ISystem<TContext> system, TContext context, string phase = "")
        where TContext : class
    {
        EnsureConfigurable();
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
        _orderedEntries = null;
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
        if (State != SystemRuntimeState.Created)
        {
            throw new InvalidOperationException($"System runtime cannot initialize from state {State}.");
        }

        State = SystemRuntimeState.Initializing;
        try
        {
            foreach (var entry in OrderedEntries())
            {
                _initializedEntries.Add(entry);
                entry.Init();
            }
            State = SystemRuntimeState.Running;
        }
        catch (Exception initError)
        {
            State = SystemRuntimeState.Faulted;
            var errors = new List<Exception> { initError };
            ShutdownInitialized(errors);
            ClearRegistration();
            State = SystemRuntimeState.Stopped;
            throw new AggregateException("System runtime initialization failed and was rolled back.", errors);
        }
    }

    public void Tick(float dt)
    {
        if (State != SystemRuntimeState.Running)
        {
            throw new InvalidOperationException($"System runtime cannot tick from state {State}.");
        }

        try
        {
            foreach (var entry in OrderedEntries())
            {
                entry.Tick(dt);
            }
        }
        catch
        {
            State = SystemRuntimeState.Faulted;
            throw;
        }
    }

    public void ShutdownAll()
    {
        if (State == SystemRuntimeState.Stopped || State == SystemRuntimeState.Stopping)
        {
            return;
        }

        State = SystemRuntimeState.Stopping;
        var errors = new List<Exception>();
        ShutdownInitialized(errors);
        ClearRegistration();
        State = SystemRuntimeState.Stopped;
        if (errors.Count > 0)
        {
            throw new AggregateException("One or more systems failed to shut down.", errors);
        }
    }

    private void EnsureConfigurable()
    {
        if (State != SystemRuntimeState.Created)
        {
            throw new InvalidOperationException($"System runtime cannot be configured from state {State}.");
        }
    }

    private void ShutdownInitialized(List<Exception> errors)
    {
        for (var i = _initializedEntries.Count - 1; i >= 0; i--)
        {
            try
            {
                _initializedEntries[i].Shutdown();
            }
            catch (Exception shutdownError)
            {
                errors.Add(shutdownError);
            }
        }
        _initializedEntries.Clear();
    }

    private void ClearRegistration()
    {
        _entries.Clear();
        _entriesById.Clear();
        _phaseOrder.Clear();
        _orderedEntries = null;
    }

    private IReadOnlyList<Entry> OrderedEntries()
    {
        if (_orderedEntries != null)
        {
            return _orderedEntries;
        }

        if (_phaseOrder.Count == 0)
        {
            _orderedEntries = [.. _entries];
            return _orderedEntries;
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
        _orderedEntries = ordered;
        return _orderedEntries;
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
