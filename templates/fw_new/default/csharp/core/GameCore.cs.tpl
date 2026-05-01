namespace __PROJECT_NAME__.Core;

public sealed class GameCore
{
    public ulong Tick { get; private set; }

    public void Step()
    {
        Tick += 1;
    }
}
