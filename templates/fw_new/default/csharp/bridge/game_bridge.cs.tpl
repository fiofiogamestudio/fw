using Godot;
using __PROJECT_NAME__.Core;
using GdArray = Godot.Collections.Array;
using GdDictionary = Godot.Collections.Dictionary;

namespace __PROJECT_NAME__.Bridge;

public partial class GameBridge : RefCounted
{
    private readonly GameCore _core = new();

    public void tick(GdArray intents)
    {
        _ = intents;
        _core.Step();
    }

    public GdDictionary get_view(long playerId)
    {
        _ = playerId;
        var view = new GdDictionary();
        view["tick"] = _core.Tick;
        view["entities"] = new GdArray();
        return view;
    }

    public GdArray get_events(long playerId)
    {
        _ = playerId;
        return new GdArray();
    }
}
