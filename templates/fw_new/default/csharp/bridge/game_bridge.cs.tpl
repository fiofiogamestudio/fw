using Godot;
using __PROJECT_NAMESPACE__.Core;
using GdArray = Godot.Collections.Array;
using GdDictionary = Godot.Collections.Dictionary;

namespace __PROJECT_NAMESPACE__.Bridge;

public partial class game_bridge : Node
{
    private readonly GameCore _core = new();

    public void close()
    {
        _core.Shutdown();
    }

    public void tick(float dt, GdArray intents)
    {
        _core.Step(dt, IntentCodec.Decode(intents));
    }

    public GdDictionary get_view()
    {
        return new GdDictionary
        {
            [BridgeField.Tick] = _core.Tick,
            [BridgeField.Count] = _core.Count,
        };
    }

    public GdArray get_events()
    {
        return EventCodec.Encode(_core.Events);
    }

    public override void _ExitTree()
    {
        close();
    }
}
