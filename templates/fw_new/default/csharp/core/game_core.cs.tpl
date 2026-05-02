namespace __PROJECT_NAME__.Core;

public sealed class GameCore
{
    private readonly CoreRuntime _runtime = new(new CoreContext());

    public ulong Tick { get; private set; }

    public void Step()
    {
        Tick += 1;
        _runtime.Tick(1.0f / 30.0f);
    }
}
