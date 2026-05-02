<Project Sdk="Godot.NET.Sdk/4.6.2">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <EnableDynamicLoading>true</EnableDynamicLoading>
    <Nullable>enable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
    <DefaultItemExcludes>$(DefaultItemExcludes);.godot/**;**/.godot/**</DefaultItemExcludes>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="csharp/**/*.cs" />
    <Compile Remove=".godot/**" />
    <Compile Remove=".godot\**" />
    <EmbeddedResource Remove=".godot/**" />
    <EmbeddedResource Remove=".godot\**" />
    <None Remove=".godot/**" />
    <None Remove=".godot\**" />
  </ItemGroup>
  <ItemGroup>
    <ProjectReference Include="fw/csharp/FwRuntime/FwRuntime.csproj" />
  </ItemGroup>
</Project>
