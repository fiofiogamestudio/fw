using static TestKit;

static class ProtoTests
{
    internal static TestCase[] Cases =>
    [
        new("valid proto subset", TestValidProto),
        new("missing proto import fails", TestMissingProtoImport),
        new("proto import traversal fails", TestProtoImportTraversal),
        new("ambiguous proto import fails", TestAmbiguousProtoImport),
        new("proto package mismatch fails", TestProtoPackageMismatch),
        new("unsupported proto fails", TestUnsupportedProto),
        new("duplicate proto fields fail", TestDuplicateProtoFields),
        new("unclosed proto fails", TestUnclosedProto),
        new("unknown proto type fails", TestUnknownProtoType),
        new("proto3 enum starts at zero", TestProtoEnumZero),
    ];

    private static void TestValidProto()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "valid.proto", """
                syntax = "proto3";
                package audit.bridge;
                import "other.proto";

                message Empty {}

                enum Kind {
                  KIND_UNSPECIFIED = 0;
                  KIND_VALUE = 1;
                }

                message Payload {
                  repeated uint32 values = 1;
                  Kind kind = 2;
                }

                message Envelope {
                  oneof payload {
                    Payload data = 1;
                    Empty empty = 2;
                  }
                }
                """);

            var dependency = Write(root, "other.proto", """
                syntax = "proto3";
                package audit.bridge;
                """);
            var schema = ProtoSchema.ParseFiles([dependency, path]);
            Equal(3, schema.Messages.Count, "message count");
            Equal(1, schema.Enums.Count, "enum count");
            Equal(2, schema.Messages["Envelope"].Fields.Count, "oneof field count");
            True(schema.Messages["Envelope"].Fields.All(item => item.IsOneof), "oneof flags");
            True(schema.Messages["Envelope"].Fields.All(item => item.OneofGroup == "payload"), "oneof group");
            Equal(2, schema.Messages["Payload"].Fields[1].Number, "field number");
            Equal("audit.bridge", schema.Package, "package");
        });
    }

    private static void TestMissingProtoImport()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "missing_import.proto", """
                syntax = "proto3";
                import "missing.proto";
                message Example {}
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "not part of the parsed schema set");
        });
    }

    private static void TestProtoImportTraversal()
    {
        WithTempDir(root =>
        {
            var source = Write(root, "schema/source.proto", """
                syntax = "proto3";
                import "../outside.proto";
                message Source {}
                """);
            var outside = Write(root, "outside.proto", """
                syntax = "proto3";
                message Outside {}
                """);
            Throws(() => ProtoSchema.ParseFiles([source, outside]), "must stay inside");
        });
    }

    private static void TestAmbiguousProtoImport()
    {
        WithTempDir(root =>
        {
            var source = Write(root, "schema/source.proto", """
                syntax = "proto3";
                import "common.proto";
                message Source {}
                """);
            var first = Write(root, "schema/a/common.proto", """
                syntax = "proto3";
                message First {}
                """);
            var second = Write(root, "schema/b/common.proto", """
                syntax = "proto3";
                message Second {}
                """);
            Throws(() => ProtoSchema.ParseFiles([source, first, second]), "is ambiguous");
        });
    }

    private static void TestProtoPackageMismatch()
    {
        WithTempDir(root =>
        {
            var first = Write(root, "first.proto", """
                syntax = "proto3";
                package first.bridge;
                message First {}
                """);
            var second = Write(root, "second.proto", """
                syntax = "proto3";
                package second.bridge;
                message Second {}
                """);
            Throws(() => ProtoSchema.ParseFiles([first, second]), "does not match");
        });
    }

    private static void TestUnsupportedProto()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "unsupported.proto", """
                syntax = "proto3";
                message Example {
                  optional string title = 1;
                }
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "unsupported message syntax");
        });
    }

    private static void TestDuplicateProtoFields()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "duplicate.proto", """
                syntax = "proto3";
                message Example {
                  string first = 1;
                  string second = 1;
                }
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "duplicate field number");
        });
    }

    private static void TestUnclosedProto()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "unclosed.proto", """
                syntax = "proto3";
                message Example {
                  string title = 1;
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "unclosed message");
        });
    }

    private static void TestUnknownProtoType()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "unknown.proto", """
                syntax = "proto3";
                message Example {
                  Missing value = 1;
                }
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "unknown type");
        });
    }

    private static void TestProtoEnumZero()
    {
        WithTempDir(root =>
        {
            var path = Write(root, "enum.proto", """
                syntax = "proto3";
                enum Kind {
                  KIND_VALUE = 1;
                }
                """);
            Throws(() => ProtoSchema.ParseFiles([path]), "first value must be zero");
        });
    }
}
