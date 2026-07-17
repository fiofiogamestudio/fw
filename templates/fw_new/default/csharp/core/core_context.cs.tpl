using System.Collections.Generic;

namespace __PROJECT_NAMESPACE__.Core;

internal sealed class CoreContext
{
    public ContextRefs Refs { get; } = new();
    public ContextConfig Config { get; } = new();
    public ContextState State { get; } = new();

    internal sealed class ContextRefs
    {
    }

    internal sealed class ContextConfig
    {
    }

    internal sealed class ContextState
    {
        public IReadOnlyList<GameIntent> Intents { get; set; } = [];
        public List<CoreEvent> Events { get; } = [];
        public int Count { get; set; }
    }
}
