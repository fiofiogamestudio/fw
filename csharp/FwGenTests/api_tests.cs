using System.Reflection;
using System.Globalization;
using System.Text;
using Fw.Rt.Bridge;
using Fw.Rt.Config;
using Fw.Rt.Systems;
using static TestKit;

static class ApiTests
{
    internal static TestCase[] Cases =>
    [
        new("C# runtime public API contract", TestRuntimeApi),
        new("C# runtime exact public API snapshot", TestRuntimeApiSnapshot),
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

    private static void TestRuntimeApiSnapshot()
    {
        var path = ApiContractPath();
        var actual = RenderPublicApi().Replace("\r\n", "\n").Trim();
        if (Environment.GetEnvironmentVariable("FW_UPDATE_API") == "1")
        {
            File.WriteAllText(path, actual + "\n", new UTF8Encoding(false));
        }
        var expected = File.ReadAllText(path).Replace("\r\n", "\n").Trim();
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
        {
            var mismatch = Math.Min(expected.Length, actual.Length);
            for (var index = 0; index < mismatch; index++)
            {
                if (expected[index] != actual[index])
                {
                    mismatch = index;
                    break;
                }
            }
            throw new InvalidOperationException(
                $"FwRuntime public API changed at character {mismatch} (expected length {expected.Length}, actual length {actual.Length}). "
                + $"Review compatibility, then update {path}.\n--- actual ---\n{actual}"
            );
        }
    }

    private static string ApiContractPath()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "tests", "contracts", "csharp_api.txt");
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        return Path.Combine(AppContext.BaseDirectory, "contracts", "csharp_api.txt");
    }

    private static string RenderPublicApi()
    {
        var text = new StringBuilder();
        var types = typeof(WireFrame).Assembly.GetExportedTypes()
            .Where(type => type.Namespace?.StartsWith("Fw.Rt.", StringComparison.Ordinal) == true)
            .OrderBy(TypeName, StringComparer.Ordinal);
        foreach (var type in types)
        {
            text.AppendLine($"type {TypeKind(type)} {TypeName(type)}{TypeBases(type)}");
            foreach (var member in RenderMembers(type).OrderBy(item => item, StringComparer.Ordinal))
            {
                text.AppendLine("  " + member);
            }
        }
        return text.ToString();
    }

    private static IEnumerable<string> RenderMembers(Type type)
    {
        const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (var constructor in type.GetConstructors(flags))
        {
            yield return $"ctor({Parameters(constructor.GetParameters())})";
        }
        foreach (var field in type.GetFields(flags).Where(field => !field.IsSpecialName))
        {
            var prefix = field.IsLiteral ? "const" : field.IsStatic ? "static field" : "field";
            var value = field.IsLiteral ? $" = {ConstantValue(field.GetRawConstantValue())}" : "";
            yield return $"{prefix} {TypeName(field.FieldType)} {field.Name}{value}";
        }
        foreach (var property in type.GetProperties(flags))
        {
            var access = (property.GetGetMethod(false) != null ? "get;" : "")
                + PropertySetter(property);
            var index = property.GetIndexParameters();
            var name = index.Length == 0 ? property.Name : $"{property.Name}[{Parameters(index)}]";
            yield return $"property {TypeName(property.PropertyType)} {name} {{{access}}}";
        }
        foreach (var @event in type.GetEvents(flags))
        {
            yield return $"event {TypeName(@event.EventHandlerType!)} {@event.Name}";
        }
        foreach (var method in type.GetMethods(flags)
            .Where(method => !method.IsSpecialName || method.Name.StartsWith("op_", StringComparison.Ordinal)))
        {
            var generic = method.IsGenericMethodDefinition
                ? $"<{string.Join(",", method.GetGenericArguments().Select(argument => argument.Name))}>"
                : "";
            var prefix = method.IsStatic ? "static method" : "method";
            yield return $"{prefix} {TypeName(method.ReturnType)} {method.Name}{generic}({Parameters(method.GetParameters())})";
        }
    }

    private static string TypeBases(Type type)
    {
        if (type.IsEnum)
        {
            return " : " + TypeName(Enum.GetUnderlyingType(type));
        }

        var bases = new List<Type>();
        if (type.BaseType != null && type.BaseType != typeof(object) && type.BaseType != typeof(ValueType))
        {
            bases.Add(type.BaseType);
        }
        var inheritedInterfaces = type.BaseType?.GetInterfaces().ToHashSet() ?? [];
        bases.AddRange(type.GetInterfaces()
            .Where(candidate => !inheritedInterfaces.Contains(candidate))
            .OrderBy(TypeName, StringComparer.Ordinal));
        return bases.Count == 0 ? "" : " : " + string.Join(", ", bases.Select(TypeName));
    }

    private static string PropertySetter(PropertyInfo property)
    {
        var setter = property.GetSetMethod(false);
        if (setter == null)
        {
            return "";
        }
        var initOnly = setter.ReturnParameter.GetRequiredCustomModifiers()
            .Contains(typeof(System.Runtime.CompilerServices.IsExternalInit));
        return initOnly ? "init;" : "set;";
    }

    private static string Parameters(IEnumerable<ParameterInfo> parameters)
    {
        return string.Join(", ", parameters.Select(parameter =>
        {
            var type = parameter.ParameterType;
            var modifier = parameter.GetCustomAttribute<ParamArrayAttribute>() != null
                ? "params "
                : parameter.IsOut
                    ? "out "
                    : parameter.IsIn
                        ? "in "
                        : type.IsByRef ? "ref " : "";
            if (type.IsByRef)
            {
                type = type.GetElementType()!;
            }
            var fallback = parameter.HasDefaultValue ? $" = {ConstantValue(parameter.DefaultValue)}" : "";
            return $"{modifier}{TypeName(type)} {parameter.Name}{fallback}";
        }));
    }

    private static string TypeKind(Type type)
    {
        if (type.IsEnum) return "enum";
        if (type.IsInterface) return "interface";
        if (type.IsValueType) return "struct";
        if (type.IsAbstract && type.IsSealed) return "static class";
        return type.IsSealed ? "sealed class" : "class";
    }

    private static string TypeName(Type type)
    {
        if (type.IsArray)
        {
            return TypeName(type.GetElementType()!) + "[]";
        }
        if (type.IsGenericParameter)
        {
            return type.Name;
        }
        if (!type.IsGenericType)
        {
            return type.FullName ?? type.Name;
        }
        var name = (type.GetGenericTypeDefinition().FullName ?? type.Name).Split('`')[0];
        return $"{name}<{string.Join(",", type.GetGenericArguments().Select(TypeName))}>";
    }

    private static string ConstantValue(object? value)
    {
        return value switch
        {
            null => "null",
            string text => $"\"{text.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"",
            char character => $"'{character}'",
            bool boolean => boolean ? "true" : "false",
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? "null",
        };
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
