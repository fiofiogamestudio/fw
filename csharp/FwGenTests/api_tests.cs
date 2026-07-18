using System.Reflection;
using Fw.Rt.Bridge;
using Fw.Rt.Config;
using Fw.Rt.Systems;
using static TestKit;

static class ApiTests
{
    internal static TestCase[] Cases =>
    [
        new("C# runtime public API contract", TestRuntimeApi),
    ];

    private static void TestRuntimeApi()
    {
        RequireConstructor(typeof(WireFrameOptions), typeof(int), typeof(int), typeof(int));
        RequireProperty(typeof(WireFrameOptions), nameof(WireFrameOptions.CompressionThresholdBytes), typeof(int));
        RequireProperty(typeof(WireFrameOptions), nameof(WireFrameOptions.MaxDecodedBytes), typeof(int));
        RequireProperty(typeof(WireFrameOptions), nameof(WireFrameOptions.MaxEncodedBytes), typeof(int));

        RequireMethod(typeof(WireFrame), nameof(WireFrame.Encode), true, typeof(byte[]), typeof(ReadOnlySpan<byte>), typeof(WireFrameOptions));
        RequireMethod(typeof(WireFrame), nameof(WireFrame.Decode), true, typeof(byte[]), typeof(ReadOnlySpan<byte>), typeof(WireFrameOptions));
        RequireMethod(typeof(WireFrame), nameof(WireFrame.HasHeader), true, typeof(bool), typeof(ReadOnlySpan<byte>));

        RequireConstant(typeof(ConfigPack), nameof(ConfigPack.HeaderSize), ConfigPack.HeaderSize);
        RequireConstant(typeof(ConfigPack), nameof(ConfigPack.Version), ConfigPack.Version);
        RequireMethod(typeof(ConfigPack), nameof(ConfigPack.Encode), true, typeof(byte[]), typeof(ReadOnlySpan<byte>), typeof(ReadOnlySpan<byte>));
        RequireMethod(
            typeof(ConfigPack),
            nameof(ConfigPack.Decode),
            true,
            typeof(Dictionary<string, System.Text.Json.JsonElement>),
            typeof(ReadOnlyMemory<byte>),
            typeof(string)
        );

        RequireMethod(typeof(ISystem<object>), nameof(ISystem<object>.Init), false, typeof(void), typeof(object));
        RequireMethod(typeof(ISystem<object>), nameof(ISystem<object>.Tick), false, typeof(void), typeof(float));
        RequireMethod(typeof(ISystem<object>), nameof(ISystem<object>.Shutdown), false, typeof(void));
        Equal(
            "Created,Initializing,Running,Faulted,Stopping,Stopped",
            string.Join(',', Enum.GetNames<SystemRuntimeState>()),
            "system runtime states"
        );

        RequireConstructor(typeof(SystemRuntime));
        RequireProperty(typeof(SystemRuntime), nameof(SystemRuntime.PhaseOrder), typeof(IReadOnlyList<string>));
        RequireProperty(typeof(SystemRuntime), nameof(SystemRuntime.State), typeof(SystemRuntimeState));
        RequireProperty(typeof(SystemRuntime), nameof(SystemRuntime.IsRunning), typeof(bool));
        RequireMethod(typeof(SystemRuntime), nameof(SystemRuntime.SetPhaseOrder), false, typeof(void), typeof(IEnumerable<string>));
        RequireMethod(typeof(SystemRuntime), nameof(SystemRuntime.Has), false, typeof(bool), typeof(string));
        RequireMethod(typeof(SystemRuntime), nameof(SystemRuntime.InitAll), false, typeof(void));
        RequireMethod(typeof(SystemRuntime), nameof(SystemRuntime.Tick), false, typeof(void), typeof(float));
        RequireMethod(typeof(SystemRuntime), nameof(SystemRuntime.ShutdownAll), false, typeof(void));
        RequireSystemAdd();
        RequireSystemGetContext();
    }

    private static void RequireConstructor(Type type, params Type[] parameters)
    {
        True(type.GetConstructor(parameters) != null, $"{type.Name} constructor");
    }

    private static void RequireProperty(Type type, string name, Type propertyType)
    {
        PropertyInfo? property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static);
        True(property != null, $"{type.Name}.{name} property");
        Equal(propertyType, property!.PropertyType, $"{type.Name}.{name} property type");
    }

    private static void RequireMethod(
        Type type,
        string name,
        bool isStatic,
        Type returnType,
        params Type[] parameters
    )
    {
        MethodInfo? method = type.GetMethod(
            name,
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static,
            null,
            parameters,
            null
        );
        True(method != null, $"{type.Name}.{name} method");
        Equal(isStatic, method!.IsStatic, $"{type.Name}.{name} static contract");
        Equal(returnType, method.ReturnType, $"{type.Name}.{name} return type");
    }

    private static void RequireConstant(Type type, string name, int value)
    {
        FieldInfo? field = type.GetField(name, BindingFlags.Public | BindingFlags.Static);
        True(field is { IsLiteral: true }, $"{type.Name}.{name} constant");
        Equal(value, (int)field!.GetRawConstantValue()!, $"{type.Name}.{name} value");
    }

    private static void RequireSystemAdd()
    {
        MethodInfo? method = typeof(SystemRuntime).GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .SingleOrDefault(item => item.Name == nameof(SystemRuntime.Add) && item.IsGenericMethodDefinition);
        True(method != null, "SystemRuntime.Add generic method");
        Type context = method!.GetGenericArguments().Single();
        ParameterInfo[] parameters = method.GetParameters();
        Equal(4, parameters.Length, "SystemRuntime.Add parameter count");
        Equal(typeof(string), parameters[0].ParameterType, "SystemRuntime.Add id type");
        True(parameters[1].ParameterType.IsGenericType, "SystemRuntime.Add system type");
        Equal(typeof(ISystem<>), parameters[1].ParameterType.GetGenericTypeDefinition(), "SystemRuntime.Add system contract");
        Equal(context, parameters[1].ParameterType.GetGenericArguments().Single(), "SystemRuntime.Add system context");
        Equal(context, parameters[2].ParameterType, "SystemRuntime.Add context type");
        Equal(typeof(string), parameters[3].ParameterType, "SystemRuntime.Add phase type");
        Equal(typeof(void), method.ReturnType, "SystemRuntime.Add return type");
    }

    private static void RequireSystemGetContext()
    {
        MethodInfo? method = typeof(SystemRuntime).GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .SingleOrDefault(item => item.Name == nameof(SystemRuntime.GetContext) && item.IsGenericMethodDefinition);
        True(method != null, "SystemRuntime.GetContext generic method");
        Type context = method!.GetGenericArguments().Single();
        ParameterInfo[] parameters = method.GetParameters();
        Equal(1, parameters.Length, "SystemRuntime.GetContext parameter count");
        Equal(typeof(string), parameters[0].ParameterType, "SystemRuntime.GetContext id type");
        Equal(context, method.ReturnType, "SystemRuntime.GetContext return type");
    }
}
