namespace __PROJECT_NAME__.Core;

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
    }
}
